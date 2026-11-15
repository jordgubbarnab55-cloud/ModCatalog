# `build.py` pipeline

`build.py` is stdlib-only Python. It generates `site/catalog.json` from the
mod releases.

## Commands

| Command | Does |
|---|---|
| `python build.py process --from-inbox` | Drain the `inbox` release (list, download, upload, delete through the client interface), validate, re-home, merge into `site/catalog.json` |
| `python build.py process --from-dir DIR --as-uid ID --as-username NAME` | Treat the directory's zips as uploads by that Discord account (seeding); never notifies |
| `python build.py rebuild` | Enumerate all `mod-*` releases and regenerate the whole catalog from scratch |
| `python build.py retitle` | Re-apply only the catalog `name` and `description` from `site/config.json` |
| `python build.py notify --results PATH [--url URL] [--secret S]` | POST the run's events to the Worker |

`--config` selects another config file. `--owner` and `--repo` default to
`GITHUB_OWNER`, `GITHUB_REPO`, or `GITHUB_REPOSITORY`.

### `process --results-file PATH`

Writes the run's outcome events as a JSON array, atomically, at the end. It
writes `[]` when there were none, including on the empty-inbox early return.
`--from-dir` may use it too but never notifies. Events:

- `published`: the catalog entry's fields reused as-is, plus
  `eventId` = `<identKeyLower>:<package sha256>`, `mode` = new/update,
  `uploaderId`, `uploaderName`, `title`, `version`, `description`, `author`,
  `identifier`, `tags`, `gameVersion`, `fileUrl`, `coverUrl`, `size`,
  `sha256`, `assetName`.
- `rejected`: `eventId` = `rej:<uploaderId>:<inbox group or asset id>`, one
  human-readable reason line (at most 300 characters), `mode` null, and
  whatever of title, version, identifier is known (else null).
- The over-7-day sweeps are `rejected` with the reason "incomplete upload
  expired".
- Incomplete groups waiting for parts emit nothing; `rebuild` emits nothing.

### `rebuild`

Reads each release's **newest** package (the entry, the `author` rename rule,
the `content_hash`) plus the **oldest valid** one, probed oldest-first with
fallback (the locked identifier; one download in practice). Cost is O(mods),
not O(upload history). `--full` (the `rebuild.yml` input `full`) reads every
package of every release.

### `notify`

- POSTs to `CATALOG_CALLBACK_URL/catalog/events`; `--url` and `--secret`
  default from the environment variables `CATALOG_CALLBACK_URL` and
  `CATALOG_CALLBACK_SECRET`. Missing values produce a one-line note and exit 0.
- 10 events per request. `X-Catalog-Signature` is the hex HMAC-SHA256 of the
  raw body keyed with the secret.
- Sends an explicit `User-Agent`: Cloudflare returns 403 for the default
  `Python-urllib` one.
- One retry 2 s later on a network error or 5xx; 4xx is final.
- Never raises and always exits 0; failures are logged. The secret is never
  printed. A missing results file is a no-op.

## Clients

Both implement `PackageClient`.

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
3. That set's `.utoc` has a valid trailer, or a `metadata.json` is present.
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
