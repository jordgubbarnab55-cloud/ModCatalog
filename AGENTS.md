# AGENTS.md

ModCatalog — a **trailer-driven public mod catalog + upload system** on free
tiers (GitHub Actions/Releases/Pages + one Cloudflare Worker). Static site
on GitHub Pages + a JSON manifest, all *generated* from the mod packages.
Serves two consumers: browsers (the web page) and **ModManager's Browse tab**
(via the manifest, the exact `catalog.json` schema its `Net/CatalogClient`
parses). Uploads come from Discord-minted tokens (no OAuth, no accounts).

## Core contract: the release assets are the source of truth

- A mod = a `.zip` **release asset** in a per-mod release tagged
  `mod-<guid>` (one release per mod), whose package is a UE container
  whose `.utoc` carries a **metadata trailer** (`"UEMODMET"` magic +
  compact UTF-8 JSON payload: `schema`/`title`/`author`/`description`/
  `version`/`guid` + optional base64 `image` PNG/JPEG ≤ 4 MiB).
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
     `<discordId>__<uploadId>__f<i>__p<j>of<n>__<safe-filename>` plus
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

Binary v1, appended at exactly `TocEnd` of the `.utoc`, zero-padded to
64 KiB: `8 B magic "UEMODMET" | u16 format_version (1) | 6 B reserved (zero)
| u64 total_size | u32 payload_size | u32 payload_crc32 | payload | padding`.

- **`trailer.py`** (stdlib only) is this repo's read/write/validate twin.
  Reading = scan last 1 MiB for the magic, then validate in the C# order:
  magic → version → reserved → alignment → size bounds → CRC32 → JSON →
  schema. Keep the two in lockstep.
- **The reference implementation is C#** in the sibling workspace
  `C:\Users\Admin\Documents\QwenWorkspace\io-trailer\` (`TrailerFormat.cs`,
  `ModMetadata.cs`, `TrailerOps.cs`), used by ModManager. When in doubt
  about the format, the C# + its tests win. **Cross-check Python-written
  trailers with C# before trusting them** (scratch console app with a
  `ProjectReference` to `io-trailer.csproj`, call
  `TrailerOps.ReadTrailer` — done this way in 2026-09 for all three
  example packages).
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
  continue): valid zip; safe member names (no absolute paths, no `..`);
  exactly one `.utoc` with a valid trailer; at least one `.ucas` and one
  `.pak`; the 100 MB check applies to *uploads* (Worker side); the built
  zip is capped at GitHub's 2 GiB per-asset limit.
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

`site/index.html` is a single self-contained file: no build step, no
framework, no CDN, no external JS. It `fetch('catalog.json',
{cache:'no-store'})` same-origin at load and renders cards dynamically —
**zero mod data in the HTML**. Design mirrors ModManager's `BrowseModCard`
(the cards there are the reference): Adonis dark palette (window
`#2A2B34`, card surface `#32323F` / hover `#3D3D4C`, fg `#F0F0F0` @ 75%
secondary, accent `#206BD4` / hover `#3C81E2`), 90×90 cover with accent
letter fallback, title 14 semibold, `author • v{version}` + description 12,
and a 52×52 solid-accent square with the Lucide inbox icon + centered size
hint (2 cards/row, 1 on narrow screens). The download button is a plain
`download` link — the zip is fetched **only on click**, never at render
time (hard requirement). Covers are plain `<img loading="lazy">` with **no**
`crossorigin` attribute and **no** `fetch()` of release URLs (browser
`fetch()` of release assets fails CORS; `<img src>` and `<a href>` work).
`file`/`cover` are absolute release URLs; `new URL(url, base)` handles
them. The `download` attribute is ignored cross-origin, but GitHub serves
release assets as attachments so downloads still start.

`site/upload.html` (same style, no deps) reads `site/config.json`
(`{"uploadUrl": ...}`) — one value the owner edits after deploying the
Worker — and shows "upload is not configured yet" while it is a
placeholder. It accepts a `.zip` **or raw container files**: in raw mode it
checks the `.utoc` for a metadata trailer with `site/trailer.js` (the
browser/Node twin of `trailer.py` — validates in the C# order, plus
`appendTrailer` for the "add metadata" form the page shows when the
trailer is missing; the page is the only place a trailer gets written in
this flow), part-splits files over 90 MB, uploads the manifest + parts
through the raw Worker contract, and polls `catalog.json` after a 202.
Uploads go via `XMLHttpRequest` (progress events). Its pure helpers live in
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
Refresh. `Net/CatalogClient` is lenient (missing `accent`/`size`/`cover`
fine). It must follow the release-URL 302 redirect (app-side setting;
verify per SETUP.md).

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
