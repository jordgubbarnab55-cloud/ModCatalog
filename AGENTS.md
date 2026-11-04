# AGENTS.md

ModCatalog — a **trailer-driven public mod catalog + upload system** on free
tiers (GitHub Actions/Releases/Pages + one Cloudflare Worker). Static site
on GitHub Pages + a JSON manifest, all *generated* from the mod packages.
Serves two consumers: browsers (the web page) and **ModManager's Browse tab**
(via the manifest). Uploads come from Discord-minted tokens (no OAuth, no
accounts).

## The shared contract: `mod-contract/` (vendored — do not edit here)

Everything this repo shares with ModManager — the trailer format, the
catalog JSON (`catalog.schema.json`), the package-shape rules, the tag
vocabulary (`tags.json`), the upload contract — is specified in
`mod-contract/`, **a synced copy** of
`C:\Users\Admin\Documents\QwenWorkspace\mod-contract\` (the canonical
one). Change it there, then
`python ../QwenWorkspace/mod-contract/tools/sync.py mod-contract`.
`tests/test_contract.py` fails when the two copies differ (only when both
repos sit side by side) and runs the shared fixtures against `trailer.py`,
`build.py` and the schema; `worker/test/contract.test.js` runs them against
`site/trailer.js` and `site/upload-lib.js`.

## Core contract: the release assets are the source of truth

- A mod = a `.zip` **release asset** in a per-mod release tagged
  `mod-<guid>` (one release per mod), whose package is a UE container
  whose `.utoc` carries a **metadata trailer** (`"UEMODMET"` magic +
  compact UTF-8 JSON payload: `schema`/`title`/`author`/`description`/
  `version`/`game_version`/`guid`/`identifier` + optional `tags` and base64
  `image` PNG/JPEG ≤ 4 MiB — `mod-contract/trailer-spec.md`).
- `site/catalog.json` is a **generated artifact — never edit it by hand**.
  All mod data (including the `id`, the trailer GUID) is derived from the
  packages. Top-level catalog `name`/`description` are constants in
  `build.py`.
- **Packages without a valid trailer are rejected** with a clear reason and
  removed from the inbox; **one bad package never blocks the rest of the
  run**. No hand-filled entries — if a package is rejected, fix the package.
- Entry URLs are the **stable** `https://github.com/<owner>/<repo>/
  releases/download/<tag>/<asset>` URLs (they 302 to short-lived signed
  URLs — never store the signed ones). The schema is URL-shaped, so moving
  packages to another host means changing `file` only.
- **Never** commit package zips or cover images to git: releases are the
  storage, and Pages must only serve the site + `catalog.json` (bandwidth).

## The inbox → re-home flow (and why)

The Worker cannot know a package's GUID without parsing the zip (10 ms CPU
on the free plan, and it must not trust client-supplied IDs), so:

1. The Worker streams each upload into one fixed release tagged
   `inbox` (it is a stateless pass-through: no parsing, no zipping).
   Asset names encode the uploader:
   - zip packages: `<discordId>__<unixts>__<safe-filename>.zip`
   - **raw file sets** (no client-side zipping; part-split into <= 90 MB
     slices when a file is over 100 MB):
     `<discordId>__<uploadId>__f<i>__p<j>of<n>__<safe-filename>` (`.utoc`,
     `.ucas`, `.pak`, optional `.sig`) plus
     `<discordId>__<uploadId>__manifest.json` (per-file sha256 of the full
     file + part counts).
   It then dispatches `process-inbox.yml` — a **wake-up only, no payload**.
2. **Each run drains the WHOLE inbox.** GitHub `concurrency` groups keep
   only one pending run (a newer queued run cancels the older pending
   one), so processing "the asset named in the dispatch payload" would
   silently strand uploads. Hence `concurrency: {group: catalog,
   cancel-in-progress: false}` — index merges never race.
3. For raw file sets the workflow first **reassembles the parts, verifies
   the per-file sha256 against the manifest, and zips the set on the
   runner** (`make_package_zip`, deterministic member order — this is where
   "no client-side zipping" is paid for; the Worker cannot, 10 ms CPU).
   Incomplete groups are left for the next run; groups stalled for over
   7 days are swept.
4. The workflow then **re-homes** the package: ensures release
   `mod-<guid>` exists (title = mod name), uploads the zip as
   `<SafeName>-<version>.zip`, uploads the cover (if any) as
   `<guid>-cover-<sha256[:8]>.png|jpg`, and deletes the inbox assets
   (whether or not processing succeeded). GitHub cannot move assets between
   releases, hence the re-upload (runners have bandwidth to spare).
5. **Versions are immutable**: an existing `<SafeName>-<version>.zip` name
   rejects the upload (never overwrite). Old versions' assets stay; the
   catalog entry points at the most recently uploaded version.
6. The workflow creates the `inbox` release if it does not exist, so
   nobody has to create it by hand. The built zip is capped at GitHub's
   2 GiB per-asset limit (the 100 MB number is only the Worker's request
   body).

## Ownership (the GUID is self-declared inside the file)

- The **first** uploader of a GUID becomes its owner (`uploader` catalog
  field, the Discord user id). Later uploads of an existing GUID from a
  different Discord id are rejected and their inbox asset deleted.
- Discord ids in the `ADMIN_DISCORD_IDS` repo variable (comma-separated,
  read from the environment) bypass the check. Uploads with no uploader
  (seeding, `--from-dir`) count as admin but never *become* the owner.
- The trailer's `author` is self-declared display text; the verified
  identity is `uploader`. Do not present `author` as verified.
- Note: `rebuild` inherits `uploader` from the existing catalog (the
  re-homed asset names don't carry the id); a fully lost catalog yields
  `uploader: null` entries, and the first subsequent uploader claims the
  GUID.

## Trailer format (and who else speaks it)

Specified in `mod-contract/trailer-spec.md`: binary v1, appended at exactly
`TocEnd` of the `.utoc` (computed from the UE 5.6 TOC header), zero-padded
to 64 KiB.

- **`trailer.py`** (stdlib only) and **`site/trailer.js`** are this repo's
  twins of the C# reference (`QwenWorkspace\io-trailer\`, used by
  ModManager). They port it exactly: TOC header parse + `TocEnd`, strict
  parse at `TocEnd`, scan fallback, writes at `TocEnd` (replacing an own
  trailer, refusing foreign data), the full payload schema, and `TrailerError`
  kinds named like the C# `TrailerErrorKind`. Lockstep is enforced by the
  shared conformance fixtures (`mod-contract/fixtures/trailer-cases.json`),
  which the C# tests also run — **when in doubt, the C# + its tests win**,
  and a disagreement means the fixture generator is wrong.
- `trailer.read_trailer(bytes)` returns normalized metadata (or raises,
  kind `NoTrailer` when there is none); `trailer.write_trailer(bytes, meta)`
  returns the new bytes.
- Trailers are normally written by **ModManager's Development tab**
  (drop the container folder in the Package drop zone).
- Trailer v1 holds **one** cover image. More preview images would need a
  schema change in lockstep with the C# reference — not done.

## Pipeline (`build.py`, stdlib only)

- `python build.py process --from-inbox` — drain the `inbox` release
  (list/download/upload/delete through the client interface), validate,
  re-home, merge into `site/catalog.json`.
- `python build.py process --from-dir <dir>` — treat the dir's zips as
  **admin** inbox items (no uploader); used for one-off seeding.
- `python build.py rebuild` — enumerate all `mod-*` releases, read each
  newest version zip's trailer, regenerate the whole catalog from scratch
  (releases are the source of truth, so a lost/corrupt catalog recovers).
- **`--client local --root <dir>`** selects the directory-backed fake
  (releases = folders, assets = files, mtime = created-at) so the whole
  pipeline runs offline; the default `gh` client shells out to the
  preinstalled `gh` CLI (auth via `GH_TOKEN`). `--owner/--repo` default to
  `GITHUB_OWNER`/`GITHUB_REPO`/`GITHUB_REPOSITORY`.
- **Per-package validation** (failure → delete the inbox asset(s), log,
  continue): valid zip ≤ 2 GiB (GitHub's per-asset limit; the 100 MB limit
  is per upload request and is enforced by the Worker, so part-split raw
  sets may exceed it); the package-shape rule shared with ModManager's
  installer (`mod-contract/package-spec.md`: no unsafe member paths, exactly
  one complete `.utoc/.ucas/.pak` (+`.sig`) set grouped by base name —
  `classify_members` / `classify_raw`); that set's `.utoc` has a valid
  trailer.
- **Catalog entries** come from one function, `entry_from_meta` (both
  `process` and `rebuild`): `gameVersion` and `tags` are emitted when
  non-empty; tags are filtered through `mod-contract/tags.json`
  (`sanitize_tags`: vocabulary casing, unknowns dropped and logged). The
  catalog carries `schemaVersion: 1` and must validate against
  `mod-contract/catalog.schema.json` (`mod-contract/tools/schema_check.py`).
- **Raw file sets** are accepted in the inbox alongside zips
  (`parse_inbox_name` / `raw_group_source` in `build.py`): manifest +
  part-split files, reassembled and zipped on the runner (see the inbox
  flow above).
- Output is **deterministic** (sorted entries, stable JSON, `updated` from
  asset creation time on rebuild) so no-op runs produce byte-identical
  output and no churn commits.

## Workflows (`.github/workflows/`, all with explicit `permissions`)

- `process-inbox.yml` — `workflow_dispatch` only (the Worker dispatches it;
  the payload carries nothing). `permissions: contents:write, pages:write,
  id-token:write`; `concurrency: {group: catalog, cancel-in-progress:
  false}`. Steps: checkout, setup-python 3.12, `python build.py process
  --from-inbox` (with `GH_TOKEN: ${{ github.token }}`), then the shared
  `commit-and-deploy` composite action.
- `rebuild.yml` — `workflow_dispatch`; `python build.py rebuild`, commit,
  deploy. Same concurrency group.
- `seed-legacy.yml` — one-off `workflow_dispatch`; `python build.py process
  --from-dir legacy-assets` (admin seeding of the example mods), commit,
  deploy. Run once after cutover, then delete `legacy-assets/` (SETUP.md
  step 8).
- `deploy-site.yml` — push to `site/**` (a human editing `index.html` /
  `upload.html` / `config.json`): upload `site/` as the Pages artifact and
  deploy. Bot pushes with `GITHUB_TOKEN` do not trigger it → no loops.
- `.github/actions/commit-and-deploy/action.yml` — commit
  `site/catalog.json` **only if changed** (scoped `git status --porcelain`
  + `git add` — a whole-tree check broke once when Python left
  `__pycache__/`), push, then `actions/upload-pages-artifact` (path `site`)
  + `actions/deploy-pages`. **The Pages deploy happens in the same run as
  the commit** because a commit pushed with `GITHUB_TOKEN` does not
  trigger other workflows.

## The Cloudflare Worker (`worker/`)

Plain JS ES modules, **zero runtime dependencies** (wrangler is a
devDependency run by the owner only). Everything service-facing is
injected: `handle(request, env, fetch)`.

- **`POST /discord`** — Interactions endpoint (slash commands over HTTPS;
  **no gateway/WebSocket bot**). Ed25519 signature check required (401
  without). PING→PONG. `/token` mints `mm_` + base64url(32 random bytes);
  only `sha256(token)` is stored (KV `tok:<hash>`, `user:<discordId>`);
  one active token per user (a new one invalidates the old); reply is
  ephemeral (flags 64). `/token revoke` deletes both keys (the Worker
  still accepts that subcommand, but the registered command is a bare,
  parameter-free `/token` — subcommand-bearing commands never rendered
  for this app — so revoke = mint again and ignore the new token).
  Response flow: 202 ACK (no body) + `POST
  /interactions/{id}/{token}/callback` (`{type:4, data:{content,
  flags:64}}`; PING ACKs with a PONG callback) — a flat inline 200
  body is rejected by Discord. The invoking user id is `member.user.id`
  (current API member objects have no top-level `id`). **No GitHub
  calls in this path** (the 3 s budget covers the 202 ACK only).
- **`POST /upload`** — `Bearer` token → 401; `Content-Length` required →
  411; over 100 MB per part → 413 **before any GitHub call** (the
  free-plan request-body limit); per-user daily **byte** quota (default
  2 GiB) → 429; missing `inbox` release → 503. Two shapes: zip mode
  (`X-Filename` must end in `.zip`) and raw mode (same `X-Upload-Id` on
  every upload plus `manifest.json`; filenames `.pak/.ucas/.utoc`), both
  **streaming `request.body` straight through** to `uploads.github.com`
  (no buffering, no storage on the Worker), dispatching
  `process-inbox.yml` (`ref: main`) and answering `202 {"status":"queued"}`.
  GitHub failure → 502 without dispatch. CORS: `Access-Control-Allow-Origin`
  = `ALLOWED_ORIGIN` only; allowed headers `Authorization, Content-Type,
  X-Filename, X-Upload-Id, X-File-Idx, X-Part-Idx, X-Part-Count`.
- KV is eventually consistent — a slightly late quota count is acceptable.
- Fine-grained `GITHUB_TOKEN` **expires** (max 1 year); expired token →
  502s. Calendar-reminder at creation.
- `scripts/register-commands.mjs` (registers the slash commands; reads
  `DISCORD_APP_ID`/`DISCORD_BOT_TOKEN` from the environment at run time,
  stores nothing) and `scripts/smoke-test.sh` (upload + catalog poll) are
  **owner** tools.

## The web page

`site/index.html` is one self-contained page plus one local ES module,
`site/catalog-lib.js`: no build step, no framework, no CDN, no external JS.
It `fetch('catalog.json', {cache:'no-store'})` same-origin at load, reads it
with `parseCatalog` and renders cards dynamically — **zero mod data in the
HTML**. ModManager's Browse tab is the reference; the page mirrors it:

- **Cards** (`BrowseModCard`): Adonis dark palette (window `#2A2B34`, card
  `#32323F` / hover `#3D3D4C`, fg `#F0F0F0` @ 75% secondary, accent
  `#206BD4` / hover `#3C81E2`), fixed 90×90 cover (card = 92 px tall) with
  the letter placeholder underneath (initial + the catalog `accent`, else a
  colour hashed from the mod id), title 14 semibold, `author • vVersion
  [• [gameVersion]]`, single-line description, and a 116 px right column
  with a 44×44 solid-accent button (Lucide inbox 20 px) + `formatBytes`
  size hint. 2 cards/row, 1 on narrow screens, catalog order.
- **Details lightbox** (`ModDetailsDialog`): a card click (not the download
  button) opens a 720×240 panel — 240 cover, wrapped description, Tags
  chips, File / Size; Esc, scrim click or ✕ closes and returns focus to
  the card. Below 760 px it stacks.
- **Filter panel** (`FilterBar` + `SearchBox`): floating, bottom-centred,
  50% of the window; chips `All` + one per tag of `site/tags.json`
  (OR-combined; hidden when `tags.json` is missing), a search box matching
  name/author/description/tags. The header count reads `N of M shown`
  while a filter is active. Catalog tags are cleaned with `sanitizeTags`
  against the same vocabulary (unknown tags dropped, as the app does).
- **`catalog-lib.js`** holds every pure helper (`parseCatalog` — the
  lenient reader of `mod-contract/catalog.md`, tested against the shared
  `catalog-cases.json` —, `sanitizeTags`, `formatBytes`, `singleLine`,
  `metaParts`, `placeholder`/`accentFor`, `matches`). They are ports of the
  app's `CatalogParser`, `TagCatalog.Sanitize`, `ByteFormat`,
  `SingleLineConverter`, `PlaceholderAccent` and `FilterViewModel.Matches`;
  the placeholder colour vectors in `worker/test/catalog-lib.test.js` are
  the ones recorded in the app's `PlaceholderAccentTests`.
- **Not mirrored** (a static page cannot): the download state widget
  (spinner / check / Retry) and auto-install — the browser owns the
  download — and `sha256` verification (release assets cannot be
  `fetch()`ed, CORS); the catalog source picker and Refresh (the page
  serves exactly one catalog); the light theme (the app is Dark-only).

The download button is a plain `download` link — the zip is fetched **only
on click**, never at render time (hard requirement). Covers are plain
`<img loading="lazy">` with **no** `crossorigin` attribute and **no**
`fetch()` of release URLs (browser `fetch()` of release assets fails CORS;
`<img src>` and `<a href>` work); a cover that fails to load is removed so
the letter placeholder shows. `file`/`cover` are absolute release URLs;
`new URL(url, base)` handles them. The `download` attribute is ignored
cross-origin, but GitHub serves release assets as attachments so downloads
still start.

`site/upload.html` (same style, no deps) reads `site/config.json`
(`{"uploadUrl": ...}`) — one value the owner edits after deploying the
Worker — and shows "upload is not configured yet" while it is a
placeholder. It accepts a `.zip` **or raw container files**: in raw mode it
checks the `.utoc` for a metadata trailer with `site/trailer.js` (the
browser/Node twin of `trailer.py`, plus `appendTrailer` for the "add
metadata" form the page shows when the trailer is missing — title, author,
version, game version, description and tag checkboxes; the page is the
only place a trailer gets written in this flow), checks the loose-file set
with `classifyRawSet` (the shared package-shape rule), part-splits files
over 90 MB, uploads the manifest + parts
through the raw Worker contract, and polls `catalog.json` after a 202.
Uploads go via `XMLHttpRequest` (progress events). The tag checkboxes come
from `site/tags.json`, which the deploy steps copy from
`mod-contract/tags.json` (gitignored; the tag section hides when it is
missing, e.g. a local preview). Its pure helpers live in
`site/upload-lib.js` and `site/trailer.js` (loaded as ES modules;
exercised by `worker/test/*.test.js`).
**Do not weaken the "no package bytes at render time" rule** for either
page.

## Adding a mod (the whole flow)

1. Discord: `/token` → copy the token.
2. Upload the `.zip` (ModManager app against `worker/README.md`'s contract,
   or `upload.html`). Or, for maintainers: `python build.py process
   --from-dir <dir>` (admin), or the `seed-legacy` workflow.
3. The `Process inbox` workflow does the rest; the mod appears in the
   catalog within a couple of minutes.

## Using it from ModManager

Browse tab → server URL:
`https://jordgubbarnab55-cloud.github.io/ModCatalog/catalog.json` →
Refresh. The app's `Net/CatalogParser` is lenient by design (any server's
catalog, `mod-contract/catalog.md`) and verifies downloads against
`sha256`. It must follow the release-URL 302 redirect (app-side setting;
verify per SETUP.md). The app also has an upload client for the Worker
contract (`Net/UploadClient`, `mod-contract/upload.md`), not yet wired
into its UI.

## Environment & tooling notes (this machine)

- Git identity is set **globally** to the GitHub account
  (`jordgubbarnab55-cloud` + noreply email); HTTPS auth goes through
  **Git Credential Manager** (the account is logged in via
  `git-credential-manager github login`). No tokens in any config.
- `gh` CLI (no `gh auth` set up) works by borrowing a GCM token:
  `TOKEN=$(printf "protocol=https\nhost=github.com\n" | git-credential-manager get | grep '^password=' | cut -d= -f2); GH_TOKEN="$TOKEN" gh ...`
- GitHub **Pages**: source = **GitHub Actions** (not a branch); deploys
  come from the workflows above (custom-Actions deploys are not subject to
  the 10-builds/hour legacy soft limit).
- **Windows Python 3.14 is cp1252-hostile**: read JSON/text with
  `encoding="utf-8"` explicitly; console output of non-ASCII (em dashes)
  mangles but files on disk are fine.
- Path trap: the file tool's `/tmp` is **not** Git Bash's
  `/tmp` (`C:\Users\Admin\AppData\Local\Temp`); Windows-native Python
  resolves neither. Use workspace-relative or absolute paths.
- CI runner quirk observed: `actions/checkout` + Python leaves
  `__pycache__/` behind — hence the `.gitignore` and the scoped status
  check in the commit step.
- Sibling repos in `C:\Users\Admin\Documents\`: `QwenWorkspace`
  (ModManager + `io-trailer` + `example_server` + the
  `example_mod/` pair the sample packages are built from) — separate git
  repo, do not assume it's on the same remote.
