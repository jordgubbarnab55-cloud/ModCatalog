# Plan — upload as a multi-step modal flow; the server writes the trailer

Two changes that ship together:

1. **The page.** Uploading moves from `site/upload.html` into a chain of
   modals on `site/index.html` (token → package → metadata editor → confirm).
2. **The contract.** The browser stops writing trailers. It uploads the
   package **unchanged** plus an optional `metadata.json`; the
   `process-inbox` runner writes the final trailer with `trailer.py`. A
   follow-up plan (`docs/plan-verified-authors.md`, done after this one by
   another agent — **not in scope here**) builds on this to force the author
   and identifier on the server. Leave clean seams for it (below).

Repos (both have committed history on a `mod-contract` branch and may have
uncommitted work — **do not commit, stash, reset, revert, push or deploy**):

- Catalog: `C:\Users\Admin\Documents\ModCatalog` (static site, Python
  pipeline, Cloudflare Worker)
- App (reference UI + the canonical contract): `C:\Users\Admin\Documents\QwenWorkspace`

## Read first

- `ModCatalog/AGENTS.md` — whole file. The web-page rules are hard
  requirements: no build step, no framework/CDN/external JS; zero mod data in
  the HTML; packages fetched only on click; covers are plain `<img>`; release
  URLs are never `fetch()`ed. Also the inbox flow, raw file sets and the
  Worker sections.
- `ModCatalog/worker/README.md` (the Worker's side of the upload contract),
  `worker/src/index.js`, `build.py` (`parse_inbox_name`, `raw_group_source`,
  `make_package_zip`, `validate_package`, `Processor._process_item`),
  `trailer.py` (`write_trailer`, `validate_metadata`).
- `QwenWorkspace/mod-contract/README.md`, `upload.md`, `package-spec.md`,
  `trailer-spec.md`. **`mod-contract` is edited only in QwenWorkspace**, then
  synced: `python mod-contract/tools/sync.py ../ModCatalog/mod-contract`
  (run from QwenWorkspace). Never edit `ModCatalog/mod-contract/` directly.
- The app's metadata editor, which the web editor must look like:
  `QwenWorkspace/ModManager/DevelopmentEditor.axaml`,
  `ModManager/ViewModels/EditorViewModel.cs`, `ModManager/EditorLightbox.axaml`,
  and the editor sections of `QwenWorkspace/AGENT_DOCS/layout-development.md`
  (image rules, downscale, tags, identifier, live preview card). Palette:
  `ModManager/Themes/Adonis.Dark.axaml`.
- The current page: `site/index.html`, `site/catalog-lib.js` (its lightbox is
  the modal style to reuse), `site/upload.html`, `site/upload-lib.js`,
  `site/trailer.js`.

## Part A — upload contract: "package + optional metadata"

Design goal: one inbox shape for both package kinds, and the runner is the
only thing that writes the stored trailer.

- **Every upload becomes a set** identified by `X-Upload-Id`, announced by a
  `manifest.json` (as raw mode already does). The manifest's `files` list is
  either the loose set (`.utoc/.ucas/.pak` + optional `.sig`) **or exactly
  one `.zip`**. The Worker must therefore accept a `.zip` file in raw mode
  (still ≤ 100 MB per request; part-split like any other file).
- **Optional metadata part**: `X-Filename: metadata.json`, its own fixed
  `X-File-Idx` (pick one, e.g. `-2`, and document it), single part. The
  manifest gets an optional `"metadata": { "sha256": "<hex>" }` so the
  runner knows to wait for it and can verify it.
- `metadata.json` body: `{ "title", "description", "version",
  "game_version", "tags": [...], "author", "guid"?: "<existing guid>",
  "image"?: { "mime", "data": base64 } | null }` — `image: null` means
  "remove the cover", absent means "keep the package's". It is untrusted
  input: validate with `trailer.validate_metadata` (same limits as the
  trailer).
- **Keep the old zip mode** (`X-Filename: *.zip`, no upload id) working —
  ModManager's `UploadClient` uses it; its package's trailer is used as-is.
  A set **without** `metadata.json` also keeps its package's trailer as-is.
- **Runner** (`build.py`): when a set has metadata, after reassembly:
  extract the `.utoc` of the set (from the zip for a zip set), apply the
  metadata with `trailer.write_trailer` (guid: metadata `guid` → else the
  existing trailer's → else new), then build the package zip
  deterministically on the runner (for a zip set: re-zip the chosen set
  members + the rewritten `.utoc`; unrelated members are dropped). Then
  validate and re-home exactly as today. A metadata `guid` that is not the
  package's existing GUID is a rejection (changing identity goes through the
  app, not the catalog). Structure the trailer step as **one function**
  (e.g. `apply_metadata(utoc_bytes, metadata, existing) -> bytes`) — the
  follow-up plan adds forced fields there.
- Update `mod-contract/upload.md` (canonical, then sync) and
  `worker/README.md`. Bump nothing else in the contract.

## Part B — reading the package in the browser (prefill only)

- **Zip: read only the `.utoc`.** Parse the End Of Central Directory from
  the file's tail with `File.slice` (search the last 64 KiB + 22 bytes for
  the EOCD signature; support ZIP64 EOCD if the archive needs it), walk the
  central directory, apply the package-shape rule (`classify` logic matching
  `build.py classify_members` / `mod-contract/package-spec.md`) to the entry
  names, then read just the chosen `.utoc`'s local header + data, and
  decompress with `DecompressionStream('deflate-raw')` (method 8) or take it
  as-is (method 0). Never read the whole zip. Put this in a pure module
  (e.g. `site/zip-lib.js`) so `node --test` can cover it (build test zips in
  the test with `node:zlib` `deflateRawSync`).
- Loose files: read the `.utoc` file directly; check the set with
  `classifyRawSet` (`upload-lib.js`).
- Prefill from `trailer.js readTrailerMeta` (title, author, version,
  game version, description, tags, cover image). No trailer → empty form
  (title prefilled from the file base name is fine). An unreadable trailer
  → empty form plus a one-line note.

## Part C — the modal flow on `index.html`

Header button "Upload a mod" (replacing the link) opens the flow. Each step
is its own modal, opened in sequence (the previous one closes); styling
reuses the details lightbox (scrim, panel, radius 8, floating ✕, Esc/scrim
close, focus handling). Closing any step cancels the whole flow (ask
nothing; nothing has been uploaded yet before the confirm).

1. **Token** — shown **only if** no token is in `localStorage`
   (`modcatalog.uploadToken`, the key `upload.html` uses today; keep it in
   localStorage, not a cookie). Field + "Continue"; explain where it comes
   from (Discord `/token`). Later steps show a small "Use a different token"
   link that clears it and returns here. If `config.json` has no usable
   `uploadUrl` (`configOk`), the button shows the "upload is not configured
   yet" message instead of starting the flow.
2. **Package** — a drop zone + file picker accepting one `.zip` **or** the
   loose `.utoc/.ucas/.pak` (+`.sig`) files. Validate (Part B), show what was
   picked (name, size) and errors inline; "Continue" only when valid.
3. **Metadata editor** — modelled on `DevelopmentEditor.axaml`: same fields,
   order, labels, placeholders, limits and layout (Title *, Author *,
   Version, Game version, Image with the 160×160 picker, Description,
   read-only Identifier derived as `Author.Title` with whitespace removed —
   `trailer.js buildIdentifier`, Tags as toggle chips from `tags.json`), and
   the live preview card (reuse the page's card renderer). Image rules from
   the app: PNG/JPEG only, hard limit 4 MiB, and above 512 KiB downscale
   toward ≤ 512 px PNG ≤ 256 KiB (canvas), with the app's warning text.
   Prefilled per Part B. Where the app says "Save to package" this says
   **"Upload"**; there is no "Remove metadata" button. Make each field's
   enabled/forced state data-driven (e.g. a `forced: { author?: string,
   identifier?: string }` input to the editor that greys the field and shows
   the forced value) — the follow-up plan fills it; here it is always empty.
4. **Confirm** — a small modal over the editor: "Upload ‹title› v‹version›
   to the catalog?" with Cancel (back to the editor, values kept) and
   Upload. Then upload (manifest, metadata.json, the files part-split at
   90 MB, progress bar), and poll `catalog.json` as `upload.html` does today;
   show queued / done / error states in this last modal (status texts from
   `upload-lib.js statusMessage`).

`site/upload.html` becomes a tiny page that redirects to `index.html#upload`
(which opens the flow), so old links keep working. The page must still work
at 375 px (modals fill the width, no horizontal scroll).

## Tests and verification

- `cd ModCatalog/worker && node --test` green: new tests for the zip reader
  (stored + deflated, nested paths, ZIP64 if supported, not-a-zip), any new
  pure helpers, and Worker tests for `.zip` in raw mode and the metadata
  part (accepted, bad headers → 400).
- `cd ModCatalog && python -m unittest discover -s tests` green: new tests
  for a zip set + metadata, a loose set + metadata, metadata removing/adding
  a cover, a mismatched guid rejected, invalid metadata rejected (inbox
  assets deleted, run continues), and a set without metadata unchanged.
- QwenWorkspace after the contract sync: `taskkill //IM ModManager.exe //F`,
  then `dotnet test ModManager.Tests` and `dotnet test io-trailer.Tests`
  green; `python mod-contract/tools/sync.py ../ModCatalog/mod-contract
  --check` says in sync.
- Browser: serve a copy of `site/` (+ `tags.json` from
  `mod-contract/tags.json`, + a `config.json` whose `uploadUrl` points at a
  local fake endpoint you run that answers 202) from the scratchpad, never
  from `site/` itself. Walk the whole flow with a zip and with loose files
  (fixtures: `QwenWorkspace/example_mod/`,
  `QwenWorkspace/example_server/files/ExampleUEMod-1.0.0.zip`): token skip
  when stored, prefill, editing, cover downscale, confirm/cancel, the
  requests the fake endpoint receives (headers + manifest + metadata.json),
  375 px. Then run the received set through `build.py process --from-inbox
  --client local --root <scratch>` to prove the runner writes the edited
  trailer end to end. Stop every server you start.

## Docs

`ModCatalog/AGENTS.md` (inbox flow, raw/zip sets, metadata part, the web
page section, remove the `upload.html` description), `worker/README.md`,
`mod-contract/upload.md` (canonical + sync). Code comments only where
something is non-obvious, describing the code itself.

## Report back

Files changed per repo, test counts, what you verified in the browser and
how, the end-to-end runner check, deviations from this plan and why, and
anything left undone or unverified.
