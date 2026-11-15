# Plan — per-mod download counts on the catalog page

**Goal.** Each mod card shows how many times the mod has been downloaded. The
number comes from GitHub's `download_count` on the release assets. The card's
count display is assumed to exist already (or be added separately); this plan
produces the data and feeds it to that display.

## Read first

- `AGENTS.md`: name yourself and claim `AGENTS/<n>` before anything else.
- `docs/architecture.md`, `docs/build-pipeline.md`, `docs/workflows.md`,
  `docs/site.md`: the parts you will edit.
- `docs/environment.md`: Windows, Python 3.14, always `encoding="utf-8"`.

## Decisions (already made; do not relitigate)

1. **Counts live in a separate generated file, `site/downloads.json`, never in
   `catalog.json`.** `catalog.json` is deterministic and committed only when it
   changes; counts change constantly and would cause a commit on every
   refresh. `catalog.json` also follows the shared contract with ModManager,
   and `mod-contract/` is vendored, so the contract is not touched.
2. **`downloads.json` is generated at deploy time and never committed**, the
   same way `site/tags.json` is. Gitignore it next to `tags.json`.
3. **Source is the GitHub release API.** `download_count` is already in the
   JSON that `GhClient` fetches. No Worker involvement: downloads go straight to
   GitHub release URLs and routing them through the Worker would break the
   stable-URL rule and ModManager's direct downloads.
4. **Refresh cadence:** hourly cron plus every existing deploy path.
5. **Fail soft on the page, fail hard in the cron.** A missing or malformed
   `downloads.json` hides the counts on the page. The cron workflow must not
   deploy when generation failed, otherwise a transient API error would deploy
   a site without counts and blank them everywhere until the next good run.

## File format

```json
{
  "generated": "2026-11-15T14:00:00Z",
  "mods": {
    "123456789.FullMod": { "total": 482, "latest": 61 }
  }
}
```

- Keyed by the catalog entry `id`, exactly as written in `catalog.json`.
- `total`: sum of `download_count` over every `.zip` asset (case-insensitive
  extension) in the mod's release. Covers and other assets are excluded.
- `latest`: `download_count` of the asset the catalog entry's `file` URL points
  at (the newest package).
- A mod with no matching release or asset is omitted, not written as 0. The
  page treats "absent" as "unknown, hide" and `0` as "show 0".

## Step 1 — `build.py`

1. `Asset` gets a `downloads: int = 0` field (constructor default, so existing
   call sites and tests keep working).
2. `GhClient._assets` reads `a.get("download_count", 0)` (coerce to a
   non-negative int; anything else becomes 0).
3. New `PackageClient.release_assets(prefix) -> dict[str, list[Asset]]`:
   tag to assets for every release whose tag starts with `prefix`.
   - `GhClient`: one paginated `repos/{owner}/{repo}/releases` call (the same
     endpoint `list_tags` already uses), not one `get_release` per tag.
   - `LocalClient`: iterate its release folders. Add a test seam for counts
     (for example a `downloads` dict keyed by `(tag, asset name)` that tests
     set; default 0).
4. Pure function `downloads_payload(catalog: dict, assets_by_tag: dict, now: str) -> dict`:
   - For each entry in `catalog["mods"]`, parse its `file` URL with
     `urllib.parse`: path must match `/<...>/releases/download/<tag>/<asset>`.
     Percent-decode tag and asset. Entries that do not match are skipped
     silently (foreign catalogs, hand-edited URLs).
   - Look the tag up in `assets_by_tag`; missing means the mod is omitted.
   - `total` and `latest` as defined above; `latest` is 0-or-omitted rules:
     if the named asset is not in the release, omit `latest`, keep `total`.
   - Return `{"generated": now, "mods": {...}}`. Sort `mods` keys for stable
     output.
5. New command `python build.py downloads [--catalog PATH] [--out PATH]`
   (default out: `SITE / "downloads.json"`; it takes the shared
   `--client/--root/--owner/--repo` flags like the other commands):
   - Read the catalog (utf-8), call `release_assets(MOD_TAG_PREFIX)`, build the
     payload, write it **atomically** (temp file in the same directory, then
     replace) with the same JSON style as `dump_catalog` (`indent=2`,
     `ensure_ascii=False`, trailing newline, `newline="\n"`).
   - On any error (API failure, unreadable catalog): print one line to stderr
     and **exit non-zero without writing or leaving a partial file**. The
     callers decide whether that is fatal (Step 3).
   - A catalog with zero mods writes `{"generated": ..., "mods": {}}`.
6. Python stays stdlib-only. Do not touch `entry_from_meta`, `write_catalog` or
   anything that shapes `catalog.json`.

### Tests (`tests/test_build.py`, stdlib unittest, `LocalClient`)

- Sum across several versions in one release; `latest` matches the asset in
  the entry's `file` URL.
- Cover and non-zip assets excluded; `.ZIP` uppercase counted.
- Entry whose tag has no release is omitted; entry with a non-release `file`
  URL (foreign host or shape) is skipped; percent-encoded tag/asset decode.
- `inbox` release never contributes (it is not under `mod-`).
- Output is stable: same inputs give byte-identical files for a fixed `now`.
- CLI path: failure (missing catalog) exits non-zero and leaves no output file.

## Step 2 — the page

1. `site/catalog-lib.js` (pure, dependency-free like the other helpers, with the
   usual `window.*` export):
   - `parseDownloads(json)`: lenient. Root must be an object with a `mods`
     object; otherwise return an empty map. For each entry keep `total` (and
     `latest`) only when a non-negative integer; drop the rest. Never throws.
   - `formatCount(n)`: truncate (never round up), at most one decimal, no
     trailing `.0`, units `k` and `M`. Vectors to pin in the test:
     `0→"0"`, `999→"999"`, `1000→"1k"`, `1234→"1.2k"`, `1250→"1.2k"`,
     `9999→"9.9k"`, `10000→"10k"`, `999999→"999.9k"`, `1000000→"1M"`,
     `1500000→"1.5M"`.
2. `site/index.html` boot code: after `catalog.json` is loaded, fetch
   `downloads.json` same-origin with `{cache: 'no-store'}` **in parallel**, never
   blocking card rendering on it. Any failure (network, 404, bad JSON) is
   silent and leaves the map empty. When the map arrives, fill the cards'
   existing count display; if a mod has no entry, hide that display instead of
   showing 0. Show `total` on the card.
3. If the details lightbox has a File/Size section, add a Downloads row
   (`total`, plus `latest` as "latest version: N" when present and different).
   Skip this if it needs layout work beyond one row.
4. Find the existing count display's slot before writing anything. If it does
   not exist yet, stop after exposing the parsed map to the render code and
   tell the owner what is missing; do not invent card markup or restyle cards.
5. Hard rules still apply: no build step, framework, CDN or external JS; the
   page still never fetches package bytes or release URLs at render time.
   `downloads.json` is a same-origin file, so this is allowed.

### Tests (`worker/test/catalog-lib.test.js`)

`formatCount` vectors above; `parseDownloads` on a valid file, a bare array,
non-object root, negative/float/string counts, and a missing `mods` key.

## Step 3 — workflows

All deploy paths must publish a fresh `downloads.json`, otherwise a deploy
without it blanks the counts until the next cron run.

1. **`.github/actions/commit-and-deploy/action.yml`**: add a step *after* the
   commit step and the `git checkout origin/main -- site` branch (that
   checkout would otherwise be able to clobber anything generated earlier) and
   next to the `cp mod-contract/tags.json site/tags.json` step:
   `python build.py downloads` with `GH_TOKEN: ${{ github.token }}`, marked
   `continue-on-error: true`. A failure must not block deploying a freshly
   processed upload. The callers (`process-inbox.yml`, `rebuild.yml`) already
   run `setup-python` and have `contents: write`. Confirm the composite action
   does not need its own Python setup.
2. **`.github/workflows/deploy-site.yml`**: add the same step (after the
   `retitle` step, before the artifact upload), `continue-on-error: true`, and
   `contents: read` in `permissions` (the block lists only `pages` and
   `id-token`, which sets everything else to none), plus `GH_TOKEN`.
3. **New `.github/workflows/refresh-downloads.yml`**:
   - `on: schedule: cron "17 * * * *"` (off the hour) and `workflow_dispatch`.
   - `permissions: contents: read, pages: write, id-token: write`.
   - `concurrency: {group: catalog, cancel-in-progress: false}` so it queues
     behind uploads and rebuilds like the other workflows.
   - Steps: checkout, setup-python 3.12, `python build.py retitle` (the
     committed `catalog.json` can carry an older title than `config.json`, and
     `deploy-site.yml` applies the config title at deploy time without
     committing; a refresh that skipped this would revert the title), then
     `python build.py downloads` (**not** `continue-on-error`: a failure ends
     the run before the deploy), `cp mod-contract/tags.json site/tags.json`,
     `actions/upload-pages-artifact@v4` (path `site`),
     `actions/deploy-pages@v4`.
   - Header comment in the style of the other workflows.
4. `.gitignore`: add `site/downloads.json` beside `site/tags.json` (check how
   `tags.json` is listed and match it).

## Step 4 — docs (describe the system as it is; no mention of this plan)

- `docs/build-pipeline.md`: add `downloads` to the command table, document
  `release_assets` under the client section and the file format.
- `docs/workflows.md`: the new workflow; the extra step in `commit-and-deploy`
  and `deploy-site`; the 60-day inactivity note for scheduled workflows below.
- `docs/site.md`: `downloads.json` in the file table (generated, gitignored,
  optional), its fail-soft behavior, `parseDownloads` and `formatCount` in the
  `catalog-lib.js` list, and in "Not mirrored" that ModManager does not show
  counts if that is still true.
- `docs/architecture.md`: one line in the components or data-flow section.
- State in the docs that the numbers are GitHub's raw asset counters: every
  request to the release URL counts (browser, ModManager, bots, retries) and
  so do the pipeline's own reads. `rebuild` downloads the newest and oldest
  package of every release (every package with `--full`), so a rebuild adds one
  or two to each mod. Deleting an asset removes its count, so a total can go
  down.

## Verification

1. `python -m unittest discover -s tests` and `cd worker && node --test` pass.
2. Offline: build a `LocalClient` root with a couple of releases, run
   `python build.py downloads --client local --root <dir> --catalog <catalog> --out AGENTS/<n>/downloads.json`
   and inspect the output.
3. Optional, read-only against the live repo: run the command with
   `GH_TOKEN` from the owner's token source (`AGENTS.md`, "GitHub
   authentication"; never print or store the token) and `--out` pointing into
   your `AGENTS/<n>/` folder. Compare two or three totals with the Releases
   page.
4. Open `site/index.html` locally with a hand-made `downloads.json` beside it:
   counts show; delete the file and reload: counts hide, cards still render;
   corrupt the file: same.
5. Lint the workflow YAML by reading it against `docs/workflows.md`; you cannot
   run it locally. List in your summary what could only be checked after a real
   run (the cron trigger, the composite-action step ordering on a real deploy).

## Out of scope

- Any change to `catalog.json`, `catalog.schema.json` or `mod-contract/`.
- Worker changes, a counting redirect, or per-day/trend history. If the owner
  later wants history or a total that never decreases, the follow-up is to keep
  snapshots in a fixed `stats` release asset (overwritten with `--clobber`),
  not in git.
- Excluding the pipeline's own rebuild downloads from the counts.
- Restyling cards or building the count display itself.

## Known risks to mention in your summary

- Scheduled workflows on public repos are disabled after 60 days without repo
  activity. Uploads keep it alive; a long quiet period would stop the hourly
  refresh silently. Every deploy still refreshes the counts.
- Cron runs are best-effort and can be delayed, so the counts can lag by more
  than an hour at busy times.
- A failed hourly refresh leaves the previously deployed counts in place (no
  deploy happens); a failed refresh inside an upload or site deploy ships that
  deploy without counts until the next successful one.
