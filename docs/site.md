# The web page (`site/`)

`site/index.html` is one self-contained page plus local ES modules: no build
step, no framework, no CDN, no external JS. At load it does
`fetch('catalog.json', {cache: 'no-store'})` same-origin, reads it with
`parseCatalog` and renders cards dynamically. There is **zero mod data in the
HTML**. The upload flow is in `docs/upload-flow.md`.

| File | Contents |
|---|---|
| `index.html` | Page, styles, icon sprite, boot code |
| `catalog-lib.js` | Pure helpers for cards and filters |
| `modal.js` | Modal helper and motion |
| `upload-*.js`, `zip-lib.js`, `trailer.js` | Upload flow (`docs/upload-flow.md`) |
| `config.json` | `{"title", "uploadUrl", ...}`, the deployer's settings |
| `catalog.json` | Generated; never edit |
| `tags.json` | Copied from `mod-contract/tags.json` at deploy time |
| `downloads.json` | Generated at deploy time (gitignored, optional); per-mod download counts |
| `upload.html` | Redirect to `index.html#upload` |
| `icons/*.svg` | Vendored `lucide-static` files |

## Download and cover rules

- **The page never fetches package bytes at render time.** The download button
  is a plain `download` link, so the zip is fetched only on click. This is a
  hard requirement.
- Covers are plain `<img loading="lazy">` with **no** `crossorigin` attribute
  and no `fetch()` of release URLs (browser `fetch()` of release assets fails
  CORS; `<img src>` and `<a href>` work). A cover that fails to load is
  removed so the letter placeholder shows.
- `file` and `cover` are absolute release URLs; `new URL(url, base)` handles
  them.
- The per-mod download count comes from `downloads.json` (a same-origin
  file, generated at deploy time; `docs/build-pipeline.md`), fetched in
  parallel with `catalog.json` with `{cache: 'no-store'}`. The page never
  blocks card rendering on it, and a missing, failed or malformed file is
  silent: the map stays empty and every count display hides (an absent
  mod hides; a count of 0 shows `0`). The counts are GitHub's raw asset
  counters, so the pipeline's own `rebuild` reads add one or two per mod
  and deleting an asset can lower a total.
- The `download` attribute is ignored cross-origin, but GitHub serves release
  assets as attachments, so downloads still start.

## Icons

Vendored `lucide-static` files in `site/icons/*.svg`, kept byte-identical to
the pack so a re-download re-syncs them. `<use>` of an external SVG file does
not render in Safari, so `scripts/sync-icons.py` generates a hidden inline
`<svg>` sprite in `index.html` (between the `icons:sprite:start` and
`icons:sprite:end` markers). Stroke attributes live on each `<symbol>`,
because the `display:none` sprite root is not in the `<use>` inheritance
chain. All icons reference the sprite as `<use href="#i-<n>">`. After changing
an icon file, rerun the script and commit both.

## Visual reference: ModManager's Browse tab

The page mirrors the app.

### Cards (`BrowseModCard`)

- Adonis dark palette: window `#2A2B34`, card `#32323F` / hover `#3D3D4C`,
  foreground `#F0F0F0` (75% secondary), accent `#206BD4` / hover `#3C81E2`.
- Fixed 90x90 cover (card is 92 px tall) over a letter placeholder (initial
  plus the catalog `accent`, else a colour hashed from the mod id).
- Title 14 semibold; `author [• vVersion] [• [gameVersion]]`, each segment
  only when non-empty (the app's `VersionMetaConverter`; same in the details
  view); single-line description.
- A 116 px right column with a 44x44 solid-accent button (Lucide download,
  20 px) and a `formatBytes` size hint.
- 2 cards per row, 1 on narrow screens, catalog order.

### Details lightbox (`ModDetailsDialog`)

A card click (not the download button) opens a 720x240 panel: 240 cover,
wrapped description, Tags chips, File and Size. Esc, scrim click or ✕ closes
it and returns focus to the card. Below 760 px it stacks. It is a `modal.js`
modal (`panelClass: "lbx"`), so it opens and closes with the same animation as
the upload modals.

### Modal motion (`modal.js` `MOTION`)

DialogHost.Avalonia 0.12.3's dialog animation, as the app's dialogs use:

- open: panel scale 0.8 to 1 and opacity 0 to 1, 300 ms SineEaseInOut;
- close: hold to 60% of the eased progress, then scale to 0.5 and opacity to 0;
- the scrim's background fades linearly over 300 ms.

A closing scrim becomes `scrim-out` (inert, no pointer events) until removed,
so `.scrim` only ever matches live modals. A step that replaces the previous
one (open the next, then close the old) swaps without replaying the
animation. No motion under `prefers-reduced-motion: reduce`.

### Header

The centred title is `site/config.json` `title`, else the catalog's `name`,
else "Mod Catalog" (`catalogTitle`); it also sets the tab `<title>`. Below it:
the count line and the "Upload a mod" button. The catalog `description` is not
shown.

### Filter panel (`FilterBar` + `SearchBox`)

- Floating, bottom-centred, 50% of the window.
- Chips: `All` plus one per tag of `site/tags.json` (OR-combined; hidden when
  `tags.json` is missing).
- A search box matching name, author, description and tags. The query splits
  on whitespace and **every word** must appear in one of those
  (case-insensitive), so `uncool galaxy` finds `Galaxy Lockers` by
  `uncool_1234`.
- The header count reads `N of M shown` while a filter is active.
- Catalog tags are cleaned with `sanitizeTags` against the same vocabulary
  (unknown tags dropped, as the app does).

## `catalog-lib.js`

Holds every pure helper: `parseCatalog` (the lenient reader of
`mod-contract/catalog.md`, tested against the shared `catalog-cases.json`),
`sanitizeTags`, `formatBytes`, `singleLine`, `metaParts`,
`placeholder`/`accentFor` and `matches`, plus `parseDownloads` (the lenient
reader of `downloads.json`: never throws, keeps `total`/`latest` only as
non-negative integers) and `formatCount` (short count form: truncated, at
most one decimal, `k`/`M` units). The first set are ports of the app's
`CatalogParser`, `TagCatalog.Sanitize`, `ByteFormat`, `SingleLineConverter`,
`PlaceholderAccent` and `FilterViewModel.Matches`. The placeholder colour
vectors in `worker/test/catalog-lib.test.js` are the ones recorded in the
app's `PlaceholderAccentTests`.

## Not mirrored (a static page cannot)

- The download state widget (spinner, check, Retry) and auto-install: the
  browser owns the download.
- `sha256` verification: release assets cannot be `fetch()`ed (CORS).
- The catalog source picker and Refresh: the page serves exactly one catalog.
- The per-mod download count: ModManager's Browse tab does not show one
  (nothing to mirror); the page shows its own, from `downloads.json`.
- The light theme: the app is dark-only.
