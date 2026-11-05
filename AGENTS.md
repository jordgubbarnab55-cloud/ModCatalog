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
  `image` PNG/JPEG ≤ 4 MiB — `mod-contract/trailer-spec.md`). In this
  catalog `author` and `identifier` are **verified** (see "Ownership").
- `site/catalog.json` is a **generated artifact — never edit it by hand**.
  All mod data (including the `id`, the trailer GUID) is derived from the
  packages. Top-level catalog `name`/`description` come from
  `site/config.json` `title`/`description` (`build.load_catalog_identity`;
  defaults `DEFAULT_CATALOG_NAME`/`DEFAULT_CATALOG_DESCRIPTION` when absent
  or blank); `python build.py retitle` re-applies only those two.
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
   Asset names encode the verified uploader as a **stamp**
   `<discordId>-<hex of the UTF-8 username>` that the Worker builds from the
   token record (never from a request header; hex survives `sanitizeFilename`
   and the `__` split; `build.parse_uploader` / `parse_inbox_name` read it).
   A name without a valid stamp is left alone as unrecognized.
   - zip packages (the old zip mode, ModManager's `UploadClient`):
     `<stamp>__<unixts>__<safe-filename>.zip`
   - **upload sets** (the web page's only mode; no client-side zipping or
     trailer writing; part-split into <= 90 MB slices when a file is over
     100 MB): `<stamp>__<uploadId>__f<i>__p<j>of<n>__<safe-filename>`
     (the loose `.utoc`/`.ucas`/`.pak` + optional `.sig`, **or exactly one
     `.zip`**) plus `<stamp>__<uploadId>__manifest.json` (per-file
     sha256 of the full file + part counts, and `"metadata": {"sha256"}`
     when a metadata part follows) and the optional
     `<stamp>__<uploadId>__metadata.json` (the trailer metadata the
     runner writes; `mod-contract/upload.md`). `__` never occurs inside a
     safe file name (the Worker collapses it).
   It then dispatches `process-inbox.yml` — a **wake-up only, no payload**.
2. **Each run drains the WHOLE inbox.** GitHub `concurrency` groups keep
   only one pending run (a newer queued run cancels the older pending
   one), so processing "the asset named in the dispatch payload" would
   silently strand uploads. Hence `concurrency: {group: catalog,
   cancel-in-progress: false}` — index merges never race.
3. For upload sets the workflow first **reassembles the parts, verifies
   the per-file sha256 against the manifest, writes the trailer, and zips
   the set on the runner** (`build_set_package` → `apply_metadata` →
   `make_package_zip`, deterministic member order — the Worker cannot, 10 ms
   CPU). **Every accepted package gets its trailer rewritten** —
   `apply_metadata` is **the one function that writes a stored trailer**:
   the metadata is the `metadata.json` when there is one, else the package's
   own trailer fields (which must exist); **`author` = the stamped username
   and `identifier` = `{discordId}.{Title, whitespace removed}` are forced**
   on top of either; GUID = the package's existing one, else new; a metadata
   `guid` that differs is a rejection; `image` absent keeps the cover, `null`
   removes it, an object replaces it. The package zip is built from the set
   members + that `.utoc` (a `.zip` set is re-zipped from its set members,
   unrelated entries dropped). The old zip mode goes through the same
   rewrite (`stamp_zip_file`), so a package edited in the app is corrected
   too. An invalid
   `metadata.json` (schema, bad base64/image, sha mismatch) rejects the
   whole set and deletes its inbox assets. A manifest that declares
   metadata makes the group wait until `metadata.json` arrives.
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

## Ownership and verified authors (the GUID is self-declared inside the file)

- The **first** uploader of a GUID becomes its owner (`uploader` catalog
  field, the Discord user id). Later uploads of an existing GUID from a
  different Discord id are rejected and their inbox asset deleted.
- Discord ids in the `ADMIN_DISCORD_IDS` repo variable (comma-separated,
  read from the environment) bypass the **ownership** check only: an admin's
  package is forced like everyone's, and the entry stays under its owner
  (its `author` is not changed to the admin's name). Every package has an
  uploader — there are no `uploader: null` entries.
- **The author is verified in this catalog** (catalog `"verifiedAuthors":
  true`): every stored package's trailer has `author` = the uploader's
  Discord **`username`** (not the display name or nickname) at upload time and
  `identifier` = `{discordUid}.{Title without whitespace}` (cosmetic, the GUID
  stays the identity), forced in `apply_metadata` whatever the package or
  `metadata.json` says. Elsewhere (ModManager's editor, `io-trailer`) the
  trailer author stays cosmetic text — nothing there changed.
- **Renames propagate only through the owner's own uploads**: after any
  successful upload by `uid`, `author` of **every** catalog entry whose
  `uploader == uid` is set to the current username. Someone who leaves keeps
  their old name. Stored packages of earlier versions are immutable release
  assets and keep the name they were uploaded with; only catalog entries
  change.
- **`rebuild` reproduces all of it from the releases alone** (only the
  runner writes into `mod-*` releases, so a trailer `identifier`'s id prefix
  is trusted): a release's owner = the uploader of its earliest valid
  package; an entry's `author` = the author of the most recently uploaded
  package (any release) by that owner id. Packages whose identifier carries
  no id prefix (not written by this catalog) are skipped with a log line.
  This reads every version zip of every release, not just the newest.
- Seeding: `process --from-dir DIR --as-uid ID --as-username NAME` (both
  required, the command refuses without them) treats the dir's zips as
  uploads by that account; it then owns them.

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
- `python build.py process --from-dir <dir> --as-uid <id> --as-username
  <name>` — treat the dir's zips as uploads by that Discord account; used
  for one-off seeding (the `seed-legacy` workflow's inputs).
- `python build.py rebuild` — enumerate all `mod-*` releases, read each
  newest version zip's trailer, regenerate the whole catalog from scratch
  (releases are the source of truth, so a lost/corrupt catalog recovers,
  `uploader` and the verified `author`s included — see Ownership).
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
- **Upload sets** are accepted in the inbox alongside zips
  (`parse_inbox_name` / `raw_group_source` / `build_set_package` in
  `build.py`): manifest + part-split files (+ metadata), reassembled,
  given their trailer and zipped on the runner (see the inbox flow above).
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
- `seed-legacy.yml` — one-off `workflow_dispatch` with required inputs `uid`
  and `username` (a Discord account); `python build.py process --from-dir
  legacy-assets --as-uid … --as-username …` (seeding the example mods as that
  account), commit, deploy. Run once after cutover, then delete
  `legacy-assets/` (SETUP.md step 8).
- `deploy-site.yml` — push to `site/**` (a human editing `index.html` /
  `config.json`): `python build.py retitle` (the deployed catalog.json gets
  the config's title at once; nothing is committed), upload `site/` as the
  Pages artifact and deploy. Bot pushes with `GITHUB_TOKEN` do not trigger
  it → no loops.
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
  only `sha256(token)` is stored (KV `tok:<hash>` → `{discordId, username,
  createdAt}`, `user:<discordId>`); `username` is the interaction user's
  account name (`member.user.username`, or `user.username` in a DM — not
  `global_name`, not the nick);
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
  (`X-Filename` must end in `.zip`) and set mode (same `X-Upload-Id` on
  every upload plus `manifest.json` (`X-File-Idx: -1`) and the optional
  `metadata.json` (`X-File-Idx: -2`, single part); filenames
  `.pak/.ucas/.utoc/.sig` or one `.zip`), both
  **streaming `request.body` straight through** to `uploads.github.com`
  (no buffering, no storage on the Worker), dispatching
  `process-inbox.yml` (`ref: main`) and answering `202 {"status":"queued"}`.
  GitHub failure → 502 without dispatch. CORS: `Access-Control-Allow-Origin`
  = `ALLOWED_ORIGIN` only; allowed headers `Authorization, Content-Type,
  X-Filename, X-Upload-Id, X-File-Idx, X-Part-Idx, X-Part-Count`.
- **`GET /whoami`** — bearer token → `200 {discordId, username}`, else 401; CORS
  as for `/upload` (`GET`, `Authorization` in the preflight). A token record
  **without** `username` (minted before verified authors) gets 401 with a
  "mint a new one with /token" message on `/whoami` **and** `/upload`.
  `/upload` stamps every inbox asset name with `<discordId>-<hex username>`
  (see the inbox flow).
- KV is eventually consistent — a slightly late quota count is acceptable.
- Fine-grained `GITHUB_TOKEN` **expires** (max 1 year); expired token →
  502s. Calendar-reminder at creation.
- `scripts/register-commands.mjs` (registers the slash commands; reads
  `DISCORD_APP_ID`/`DISCORD_BOT_TOKEN` from the environment at run time,
  stores nothing) and `scripts/smoke-test.sh` (upload + catalog poll) are
  **owner** tools.

## The web page

`site/index.html` is one self-contained page plus local ES modules
(`catalog-lib.js` for the cards, `upload-*.js`/`modal.js`/`zip-lib.js`/
`trailer.js` for the upload flow): no build step, no framework, no CDN, no
external JS.
It `fetch('catalog.json', {cache:'no-store'})` same-origin at load, reads it
with `parseCatalog` and renders cards dynamically — **zero mod data in the
HTML**. ModManager's Browse tab is the reference; the page mirrors it:

- **Cards** (`BrowseModCard`): Adonis dark palette (window `#2A2B34`, card
  `#32323F` / hover `#3D3D4C`, fg `#F0F0F0` @ 75% secondary, accent
  `#206BD4` / hover `#3C81E2`), fixed 90×90 cover (card = 92 px tall) with
  the letter placeholder underneath (initial + the catalog `accent`, else a
  colour hashed from the mod id), title 14 semibold, `author [• vVersion]
  [• [gameVersion]]` (each segment only when non-empty — the app's
  `VersionMetaConverter`; the details view too), single-line description,
  and a 116 px right column
  with a 44×44 solid-accent button (Lucide inbox 20 px) + `formatBytes`
  size hint. 2 cards/row, 1 on narrow screens, catalog order.
- **Details lightbox** (`ModDetailsDialog`): a card click (not the download
  button) opens a 720×240 panel — 240 cover, wrapped description, Tags
  chips, File / Size; Esc, scrim click or ✕ closes and returns focus to
  the card. Below 760 px it stacks. It is a `modal.js` modal
  (`panelClass: "lbx"`), so it opens and closes with the same animation as
  the upload modals.
- **Modal animation** (`modal.js` `MOTION`, DialogHost.Avalonia 0.12.3's
  dialog animation, which the app's dialogs use): open = panel scale
  0.8→1 + opacity 0→1, 300 ms SineEaseInOut; close = hold to 60 % of the
  eased progress, then scale →0.5 + opacity →0; the scrim's background
  fades linearly over 300 ms. A closing scrim becomes `scrim-out` (inert,
  no pointer events) until it is removed, so `.scrim` only ever matches
  live modals. A step that replaces the previous one (open the next, then
  close the old) swaps without replaying the animation. None under
  `prefers-reduced-motion: reduce`.
- **Header**: the centred title is `site/config.json` `title`, else the
  catalog's `name`, else "Mod Catalog" (`catalogTitle`); it also sets the
  tab `<title>`. Below it the count line and the "Upload a mod" button. The
  catalog `description` is not shown.
- **Filter panel** (`FilterBar` + `SearchBox`): floating, bottom-centred,
  50% of the window; chips `All` + one per tag of `site/tags.json`
  (OR-combined; hidden when `tags.json` is missing), a search box matching
  name/author/description/tags — the query splits on whitespace and
  **every word** must appear in one of those (case-insensitive), so e.g.
  `uncool galaxy` finds `Galaxy Lockers` by `uncool_1234`. The header
  count reads `N of M shown`
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

**Uploading** is a chain of modals on `index.html` (the header's "Upload a
mod" button; `upload.html` is only a redirect to `index.html#upload`, which
opens the flow, so old links work). `config.json` (`{"title": ...,
"uploadUrl": ...}`, the deployer's settings; `uploadUrl` is filled in after
deploying the Worker) feeds it; while `uploadUrl` is a
placeholder the button shows "upload is not configured yet". The steps, each
its own modal in the details lightbox's style (`modal.js`: scrim, panel,
floating ✕, Esc/scrim close, focus trap; closing any step cancels the whole
flow; nothing is uploaded before the confirm):

1. **Token** — only when `localStorage` `modcatalog.uploadToken` is empty
   (from Discord `/token`); later steps have "Use a different token". The
   token is **validated with `GET /whoami`** (derived from `uploadUrl`,
   `checkToken` in `upload-lib.js`): on Continue, and for a stored token when
   the flow starts. A 401 clears the stored token and shows the server's
   message on the token step; a network/server failure offers "Try again". The
   result (`{discordId, username}`) lives in the session.
2. **Package** — drop/pick one `.zip` or the loose `.utoc/.ucas/.pak(+.sig)`
   (`classifySelection` in `upload-lib.js`). A zip is read **only at its
   `.utoc`**: `zip-lib.js` slices the End Of Central Directory (ZIP64
   aware), the central directory and that one member out of the `File`
   and inflates it with `DecompressionStream('deflate-raw')` — the whole zip
   is never read; the zip package-shape rule is `classifyMembers`.
   Loose files: the `.utoc` is read directly. The `.utoc` must be a UE 5.6
   (v8), non-OnDemand TOC (what the server can write to). There is no
   Continue button: a valid pick or drop goes straight to the editor; while
   the `.utoc` is read the drop zone shows a spinner (`aria-busy`, further
   picks ignored), and an invalid selection stays on the step with the error
   in a boxed `role="alert"` line under the zone.
3. **Metadata editor** (`upload-editor.js`) — ModManager's
   `DevelopmentEditor` on the web: Title \*, Author \*, Version, Game
   version, the 160×160 image picker (PNG/JPEG by magic bytes, hard limit
   4 MiB, over 512 KiB warns and downscales to ≤ 512 px PNG through a
   canvas; a small ✕ removes the cover, which the app lacks), Description,
   Tags as toggle chips from `site/tags.json`, then the read-only Identifier
   (`Author.Title`, whitespace removed; the app puts it above the tags, the
   web puts the editable tags first), and a live preview card (the
   page's own `renderCard(mod, {preview: true})`). Prefilled from the
   package's trailer (`trailer.js readTrailer`; no trailer → empty form
   with the title from the file name; an unreadable one → empty form + a
   note). **Each field's enabled/forced state is data-driven:**
   `createEditor({ forced: { author?: string, identifier?: string | (form)
   => string } })` greys the field and shows/uploads the forced value. The
   flow passes `forcedFields(identity)`: author = the Discord username,
   identifier = `{discordId}.{Title, whitespace removed}` updating live with
   the title; the preview card shows them. **Iff** the package's trailer
   author differs from the username, a warning line (`authorMismatchNote`)
   says the catalog will publish it as `<username>` instead. The server
   enforces the same values regardless of what the page sends. No version-format rules are enforced (the app's
   `{0-999}.{1-999}` / game-version ranges are app-side), only the trailer's
   lengths.
4. **Confirm** — "Upload ‹title› v‹version›?" over the editor (Cancel
   returns to the editor with the values kept), then the upload: manifest,
   `metadata.json`, the files part-split at 90 MB, through
   `XMLHttpRequest` with a progress bar (not dismissible while sending). A
   failed request leaves the editor open underneath ("Back to the editor" /
   Esc keep the form). Once every request is accepted the editor modal closes
   and the confirm modal becomes the result ("‹title› v‹version› is
   uploaded", `uploadedText`), dismissible by Close / Esc / scrim / ✕, while
   it polls `catalog.json` (`findPublishedMod`, new id or changed
   file/version) for up to ~3 minutes and then shows `doneText`; dismissing
   it ends the session and aborts the poll. Statuses come from
   `statusMessage`.

The browser sends the package bytes **unchanged** and never writes a
trailer; the metadata travels as `metadata.json` (`buildMetadataJson`;
`image` omitted = keep the package's cover, `null` = remove). The tag chips
come from `site/tags.json`, which the deploy steps copy from
`mod-contract/tags.json` (gitignored; the tags section hides when it is
missing, e.g. a local preview). Pure helpers: `upload-lib.js`, `zip-lib.js`,
`trailer.js` (exercised by `worker/test/*.test.js`); DOM code:
`upload-flow.js`, `upload-editor.js`, `modal.js`.
**Do not weaken the "no package bytes at render time" rule** for the
page (the upload flow reads only the user's own picked file, never a
release URL).

## Adding a mod (the whole flow)

1. Discord: `/token` → copy the token.
2. Upload the `.zip` or the loose files (ModManager app against
   `worker/README.md`'s contract, or the page's "Upload a mod" button). Or, for maintainers: `python build.py process
   --from-dir <dir> --as-uid <id> --as-username <name>`, or the `seed-legacy`
   workflow.
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
