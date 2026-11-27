# `build.py` pipeline

`build.py` is stdlib-only Python. It generates `site/catalog.json` from the
mod releases.

## Commands

| Command | Does |
|---|---|
| `python build.py process --from-inbox` | Drain the `inbox` release (list, download, upload, delete through the client interface), validate, re-home, merge into `site/catalog.json` |
| `python build.py process --from-dir DIR --as-uid ID --as-username NAME` | Treat the directory's zips as uploads by that Discord account (seeding); never announces |
| `python build.py rebuild` | Enumerate all `mod-*` releases and regenerate the whole catalog from scratch, reading the newest package of each |
| `python build.py retitle` | Re-apply only the catalog `name` and `description` from `site/config.json` |
| `python build.py downloads` | Write `site/downloads.json`: per-mod download counts from the release assets' `download_count` (not committed; regenerated at deploy time) |
| `python build.py announce --results PATH` | Post the run's events to Discord |

`--config` selects another config file. `--owner` and `--repo` default to
`GITHUB_OWNER`, `GITHUB_REPO`, or `GITHUB_REPOSITORY`.

### `process --results-file PATH`

Writes the run's outcome events as a JSON array, atomically, at the end. It
writes `[]` when there were none, including on the empty-inbox early return.
`--from-dir` may use it too but never announces. Events:

- `published`: the catalog entry's fields reused as-is, plus
  `eventId` = `<identKeyLower>:<package sha256>`, `key`, `mode` = new/update,
  `uploaderId`, `uploaderName`, `title`, `version`, `description`, `author`,
  `identifier`, `tags`, `gameVersion`, `fileUrl`, `coverUrl`, `size`,
  `sha256`, `assetName`.
- `rejected`: `eventId` = `rej:<uploaderId>:<key>`, `key`, one
  human-readable reason line (at most 300 characters), `mode` null, and
  whatever of title, version, identifier is known (else null).
- `key` identifies the upload in the Worker's upload status table
  (`docs/worker.md`): the upload id of a set, or `<ts>__<safe-name>.zip` for a
  zip package (`parse_inbox_name`'s `key`, the inbox asset name without the
  uploader stamp).
- The over-7-day sweeps are `rejected` with the reason "incomplete upload
  expired".
- Incomplete groups waiting for parts emit nothing; `rebuild` emits nothing.

### `rebuild`

Reads each release's **newest** package only: the entry, the locked
identifier and owner (`apply_metadata` stamps both on every stored package),
the `author` rename rule and the `content_hash`. The duplicate tie-break
("earliest first package") uses `asset_order_key` of the release's oldest zip,
from asset metadata, with no download. Cost is O(mods), not O(upload
history). Each read goes through the release URL, so a rebuild adds one to
each mod's download count.

### `downloads`

Writes `site/downloads.json` (gitignored, generated at deploy time; never in
`catalog.json`, which stays deterministic). The document:

```json
{
  "generated": "2026-11-15T14:00:00Z",
  "mods": {
    "123456789.FullMod": { "total": 482, "latest": 61 }
  }
}
```

Keyed by the catalog entry `id`. `total` is the sum of `download_count`
over every `.zip` asset (case-insensitive extension) of the mod's release
(covers and other assets excluded); `latest` is the count of the asset the
entry's `file` URL points at. Entries whose `file` URL is not
`/…/releases/download/<tag>/<asset>` (foreign host or shape) are skipped
silently (the URL's tag and asset are percent-decoded); a mod with no
matching release is omitted, not written as 0 — the page shows 0 as `0` and
an absent mod as nothing. `latest` is omitted when the named asset is not
in the release. `mods` keys are sorted; the write is atomic (temp file +
replace, the `dump_catalog` JSON style). On any error (missing or
unreadable catalog, API failure) the command prints one line to stderr and
exits non-zero without writing; the callers decide whether that is fatal
(`docs/workflows.md`). A catalog with zero mods writes an empty `mods`.
The counts are GitHub's raw asset counters: every request to the release URL
counts (browser, ModManager, bots, retries) and so do the pipeline's own
reads — a `rebuild` downloads the newest package of every release, so it adds
one to each mod, and deleting an asset removes its count, so a total can go
down.

### `announce`

Posts the results file's published mods to the Discord REST API (`urllib`,
explicit `User-Agent`, `Authorization: Bot <token>`) and reports every
published and rejected event to the Worker. It reads, from the environment:

| Variable | Meaning |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token (never printed) |
| `FORUM_CHANNEL_ID` | The forum channel mods get threads in |
| `FORUM_TAG_IDS` | JSON object, catalog tag -> forum tag id (default `{}`; unknown tags ignored, at most 5 applied) |
| `SITE_URL` | Link appended to the first message of a thread |
| `WORKER_URL` | The Worker's base URL; outcomes go to `<WORKER_URL>/uploads/results` |
| `UPLOAD_RESULTS_SECRET` | Bearer secret for that endpoint (never printed) |

`--client`, `--root`, `--owner` and `--repo` behave as for the other commands
(owner and repo are needed to reach the mod releases).

- A missing token or forum channel skips the forum threads, and a missing
  `WORKER_URL` or secret skips the status report; each prints one line.
  Nothing set exits 0 at once. A missing or unreadable results file is a
  no-op. The command never raises and always
  exits 0; one failing event is logged and never stops the others. There is
  no batching and no event-id dedup: each run announces its own events once.
- `published`: `<@uploaderId> published **title** vVERSION` plus the cleaned
  description and the site link, as a new forum thread (named after the
  title) with the cover embed (footer `mod-id: <identifier>`) and the mapped
  forum tags. When the mod already has a thread, `<@uploaderId> uploaded
  **vVERSION**` plus the description is posted into it instead.
- The thread id lives in the mod release's notes as a line
  `discord-thread: <id>` (`PackageClient.release_notes` /
  `set_release_notes`; the rest of the notes is preserved). A 404 or 403 on
  the post means the thread is gone: a new thread is created and the line
  rewritten.
- `rejected` events post nothing to Discord.
- Upload status report: the published and rejected events are POSTed to
  `<WORKER_URL>/uploads/results` as `{key, discord_id, status, title,
  version, reason}` records, 20 per request, with `Authorization: Bearer
  <UPLOAD_RESULTS_SECRET>` (`docs/worker.md`). Events without a `key` are
  skipped; a failing request is logged by status only. The Worker shows the
  result in the #mods "Check upload status" reply.
- Text from events is cleaned: backticks and `@` removed, then truncated
  (title 200, forum thread name 100, version 50, description 500,
  message 2000). Every payload sets `allowed_mentions` to `parse: []` plus the
  uploader only, so user text can never ping `@everyone` or a role.
- A 429 is retried once after the `retry_after` wait (capped at 5 s); a second
  429 fails that event.
- The HTTP call is injectable (`announce_events(..., http=...)`), so the tests
  run offline.

## Clients

Both implement `PackageClient`. `release_notes(tag)` and
`set_release_notes(tag, text)` read and replace a release's body (`GhClient`
through the releases API and `gh release edit`; `LocalClient` through a notes
file under `<root>/meta/<tag>/`). `release_assets(prefix)` returns `tag ->
assets` for every release whose tag starts with `prefix`; `GhClient` makes
one paginated `repos/{owner}/{repo}/releases` call (the same endpoint
`list_tags` uses), `LocalClient` iterates its release folders and fills
`Asset.downloads` from its `downloads` dict keyed `(tag, asset name)` (a
test seam; default 0). `GhClient` reads `download_count` into
`Asset.downloads` (a non-negative int; anything else is 0).

`Asset.label` is the GitHub asset label (`""` when none). `upload_asset(tag,
src, name, label=None)` sets it: `GhClient` uploads with gh's `path#label`
syntax, `LocalClient` stores a sidecar file under `<root>/meta/<tag>/labels/`
that listings never show. Every package zip uploaded to a `mod-*` release is
labelled `<content_hash>:<package_fingerprint>` (full hex of both).

- `GhClient` (default): shells out to the preinstalled `gh` CLI, auth via
  `GH_TOKEN`. Releases are GitHub release tags, assets are release assets.
- `LocalClient` (`--client local --root <dir>`): a directory-backed fake;
  releases are folders, assets are files, mtime is created-at. The whole
  pipeline runs offline, and the unit tests use it.

## Per-package validation

A failure deletes the inbox asset(s), logs, and continues with the next
package.

1. Valid zip, at most 2 GiB. The 100 MB limit is per upload request and is
   enforced by the Worker, so part-split sets may exceed it.
2. Package shape (`mod-contract/package-spec.md`, shared with ModManager's
   installer): no unsafe member paths, exactly one complete
   `.utoc/.ucas/.pak` (+ `.sig`) set grouped by base name
   (`classify_members` / `classify_raw`).
3. That set's `.utoc` has a valid trailer, or the manifest carries `metadata`.
4. New-mod/update resolution with ownership, not a duplicate of another mod's
   current entry, not an unchanged re-upload (`docs/inbox-pipeline.md`).

## Catalog entries

- Both `process` and `rebuild` build entries with one function,
  `entry_from_meta`.
- `gameVersion` and `tags` are emitted when non-empty. Tags are filtered
  through `mod-contract/tags.json` (`sanitize_tags`: vocabulary casing,
  unknowns dropped and logged).
- The catalog carries `schemaVersion: 1` and must validate against
  `mod-contract/catalog.schema.json` (`mod-contract/tools/schema_check.py`).

## Determinism

Output is deterministic: sorted entries, stable JSON, `updated` from asset
creation time on rebuild. A no-op run produces byte-identical output and no
churn commit.

## Encoding

Always read and write text with `encoding="utf-8"` (`docs/environment.md`).
