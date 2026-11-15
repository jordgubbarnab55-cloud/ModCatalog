# Plan — parity between ModManager's Browse cards and the ModCatalog web page

**Reference: the ModManager app.** Make `ModCatalog/site/index.html` look and
behave like the app's Browse tab wherever a static web page can, and record
the places where it can't.

Repos (two separate git repos, both with uncommitted work from earlier
sessions — **do not revert, stash, reset or commit anything**):

- App: `C:\Users\Admin\Documents\QwenWorkspace` (Avalonia 12 / .NET 10)
- Catalog: `C:\Users\Admin\Documents\ModCatalog` (static site + Python + Worker)

## Read first

- `QwenWorkspace/AGENTS.md` and the docs it requires for your task:
  `AGENT_DOCS/layout-browse.md` (the Browse card + filter spec),
  `AGENT_DOCS/layout-library.md` (FilterBar, details lightbox),
  `AGENT_DOCS/theming.md` (palette), `AGENT_DOCS/tooling.md` (build trap +
  screenshots), `AGENT_DOCS/mvvm.md` (before touching any C#).
- `ModCatalog/AGENTS.md` — especially "The web page" rules, which are hard
  requirements: no build step, no framework/CDN/external JS; **zero mod data
  in the HTML**; packages are fetched **only on click**; covers are plain
  `<img loading="lazy">` with no `crossorigin` and **no `fetch()` of release
  URLs** (CORS fails); same-origin `catalog.json` fetch with `no-store`.
- `QwenWorkspace/mod-contract/README.md` + `catalog.md` (catalog reading
  rules) — `ModCatalog/mod-contract/` is a vendored copy: **never edit it in
  ModCatalog**; if the contract must change, edit `QwenWorkspace/mod-contract`
  and run `python mod-contract/tools/sync.py ../ModCatalog/mod-contract`.

App source of truth for this work:

| what | file |
|---|---|
| card | `ModManager/BrowseModCard.axaml` (+ `.axaml.cs`) |
| details lightbox | `ModManager/ModDetailsDialog.axaml` |
| filter panel | `ModManager/Controls/FilterBar.axaml`, `Controls/SearchBox.axaml`, `ViewModels/FilterViewModel.cs` (`Matches`) |
| tab behaviour | `ModManager/ViewModels/BrowseViewModel.cs`, `BrowsePanel.axaml` |
| size text | `ModManager/Models/ByteFormat.cs`, `Models/RemoteMod.cs` (`SizeDisplay`) |
| description line | `ModManager/SingleLineConverter.cs` |
| placeholder colour | `ModManager/Services/LibraryScanner.cs` (`AccentFor`, `HslToRgb`) |
| catalog reading | `ModManager/Net/CatalogParser.cs`, `Net/CatalogClient.cs` |
| palette | `ModManager/Themes/Adonis.Dark.axaml` |

Current web page: `ModCatalog/site/index.html` (cards only: cover, name,
`author • vversion`, description, a 52×52 download link + size hint).

## Step 0 — fix the app's own placeholder (small, do it first)

The Browse card's letter placeholder is broken in the app: `CatalogClient`
never sets `RemoteMod.Initial` (always the default `"?"`) and leaves
`AccentBrush` null when the catalog has no `accent` (transparent square). The
Library tab does it properly (`LibraryScanner`: first letter of the title,
upper-cased; `AccentFor(key)` = FNV-1a over the key's UTF-16 chars →
`HslToRgb((h % 360)/360, 0.55, 0.55)`).

- Move `AccentFor` + `HslToRgb` into one shared helper (e.g.
  `Models/PlaceholderAccent.cs`, returning an `ImmutableSolidColorBrush`,
  plus a method returning the `#RRGGBB` string for tests); `LibraryScanner`
  uses it unchanged (same key: the file base name).
- `CatalogClient.LoadCatalogAsync`: `Initial` = first char of `Name`
  upper-cased (`"?"` when empty), `AccentBrush` = the catalog `accent` when
  it parses, else `PlaceholderAccent.For(entry.Id)`.
- Tests in `ModManager.Tests`: a few fixed key → `#RRGGBB` vectors (record
  them; Step 2 reuses them for JS), and that a Browse mod without
  cover/accent gets a non-null brush + its initial.
- `taskkill //IM ModManager.exe //F` before every `dotnet build`/`test`.
  Do not touch the Development-tab files (`DevelopmentPanel.axaml`,
  `PackService.cs`, `ViewModels/DevelopmentViewModel.cs`,
  `Toast/Toast.cs`, `DevelopmentViewModelTests.cs`) — they hold someone
  else's uncommitted work.
- Update `AGENT_DOCS/layout-browse.md` (RemoteMod / CatalogClient bullets).

## Step 1 — pure helpers module `site/catalog-lib.js`

A dependency-free ES module (like `upload-lib.js`: exports + `window.*`
assignment when `window` exists), loaded by `index.html`, unit-tested with
`node --test` from `worker/`. Port **exactly** from the app:

1. `parseCatalog(json, catalogUrl)` — the lenient reader of
   `mod-contract/catalog.md` (`CatalogParser.cs` is the reference): bare
   array or `{mods}` root; alias keys; number/string leniency; comma tags;
   `sha256` normalization; http(s)-only resolved URLs; non-objects,
   URL-less entries and duplicate ids skipped (counted). Return
   `{ schemaVersion, name, description, mods, skipped, warnings }`.
   **Test against `mod-contract/fixtures/catalog-cases.json`** (same
   expectations as `ModManager.Tests/ContractTests.cs`; use `.href` where
   C# uses `AbsoluteUri` — check the `%20` case).
2. `sanitizeTags(tags, vocabulary)` — `TagCatalog.Sanitize`: trim, skip
   blanks, keep vocabulary tags in vocabulary casing, order-preserving,
   case-insensitive dedupe.
3. `formatBytes(n)` — `ByteFormat.FormatBytes`: `< 1024` → `"N B"` exactly;
   else binary units with `0.#` (at most one decimal, no trailing `.0`):
   `1536 → "1.5 KB"`, `10485760 → "10 MB"`. The card hint uses
   `formatBytes(size)` for any size, including 0 → `"0 B"` (app behaviour).
4. `singleLine(text)` — `SingleLineConverter` (`\r\n`, `\n`, `\r` → space).
5. `metaParts(mod)` → the meta line pieces: `author`, `•`, `v{version}`,
   and `•`, `[{gameVersion}]` only when `gameVersion` is non-empty.
6. `placeholder(mod)` → `{ initial, color }` with Step 0's rule (initial =
   first UTF-16 char of name upper-cased, `?` if empty; colour = valid
   catalog `accent`, else FNV-1a(id) → the same HSV-style `HslToRgb`,
   `Math.round` per channel). **Test with Step 0's recorded vectors.**
7. `matches(mod, query, selectedTags)` — `FilterViewModel.Matches`: selected
   tags are OR-ed against the mod's (sanitized) tags, case-insensitive; then
   the trimmed query is a case-insensitive substring of name, author,
   description or any tag.

## Step 2 — the card (`index.html`)

Match `BrowseModCard.axaml` pixel-for-pixel at desktop width:

- Card: grid `auto 1fr auto`, background `#32323F`, 1px border `#272730`,
  radius 8, hover `#3D3D4C` / `#585871`, `cursor: pointer` (the body opens
  the details, Step 3).
- Cover: **fixed 90×90** (it drives the card height: card = 90 + border),
  radius 4, `object-fit: cover`; the placeholder (Step 1.6) underneath —
  letter 28px bold white.
- Info column: margin 12 top/left/bottom, 0 right, gap 2; title 14 semibold
  ellipsis; meta line 12px at 75% foreground with 6px spacing (Step 1.5);
  description 12px, `singleLine`, ellipsis.
- Right column: **width 116**, margin `12px 12px 12px 0`, stack aligned
  right, gap 6: a **44×44** solid-accent button (`#206BD4`, hover
  `#3C81E2`; take the corner radius from the app's Semi `SolidButton` theme)
  with the Lucide `inbox` icon at **20px, stroke 2**; the size hint (11px,
  75%) centered under the button, growing **left only** when wider (its right
  edge never passes the button's).
- The button stays a plain `<a href download>` (packages only on click).
  Clicking it must not open the details.
- Order: catalog order (the app shows mods in catalog order; `build.py`
  already sorts by name).
- Grid: 2 cards per row, 12px gap (keep the existing 1-column narrow layout).

## Step 3 — details lightbox (card click)

Mirror `ModDetailsDialog.axaml`: a modal over a scrim, panel **720×240**,
background `#32323F`, border `#272730`, radius 8:

- Left 240×240 cover (letter placeholder at 72px).
- Right: title row (name 16 semibold, ellipsis | right-aligned meta line,
  12px), margins `20 20 48 0`; description 12px **wrapped** (full text, not
  single-line), margins `20 12 20 12`; bottom block: 1px separator, a
  **Tags** row of read-only chips (label column 48px, chip radius 10,
  padding 2×8, 11px, background `#3D3D4C`, border `#272730`; row hidden
  when no tags), and a `File` (file name from the package URL, decoded) /
  `Size` (`formatBytes`) row (labels 11px 75%, values 12px).
- A 30×30 `✕` close button floating top-right (margin 8, transparent; hover
  `#3D3D4C` + full foreground). Esc and a scrim click close it; focus returns
  to the card. Reuse the open lightbox's own `<img>` src (no new fetch).
- Web-only adaptation: below ~760px viewport width, stack the cover above
  the text and let the panel fill the width (no horizontal scroll).

## Step 4 — filter panel

Mirror `FilterBar` + `SearchBox` + the Browse tab's filter behaviour:

- A floating panel, bottom-centered, **50% of the window width** (full width
  minus 16px gutters on narrow screens), radius 12, padding `12px 16px`,
  background `#32323F`, border `#272730`. The grid gets enough bottom
  padding that the last row scrolls above the panel (the app uses 172 DIP).
- Row 1: chips `All` + one per tag in `tags.json` (the site copy of
  `mod-contract/tags.json`, written by the deploy steps; gitignored). Chip:
  11px, padding 2×8, radius 10, margin-right 6, background `#3D3D4C`,
  75% foreground, border `#272730`; hover background `#585871`; selected =
  accent background, white text, accent border (hover `#3C81E2`). `All`
  clears every chip and is "selected" when none is. Multiple chips = OR.
  The chip row scrolls horizontally only when it overflows. If `tags.json`
  fails to load, hide the chip row (search still works).
- Row 2 (gap 12): the search box — placeholder `Search mods and tags…`, the
  Lucide `search` icon (20px, stroke 2) on the left, live filtering on input
  with `matches` (Step 1.7).
- Tags shown on cards/lightbox/filtering go through `sanitizeTags` with the
  same vocabulary (unknown catalog tags are dropped, as the app does).
- Feedback: the app toasts "N of M shown" on a chip toggle; the page has no
  toasts, so make the existing header count line read `N of M shown` while
  a filter is active (else `M mods available`). Empty result: show a short
  "No mods match" line in the grid.

## Step 5 — loading and errors

- Use `parseCatalog` instead of reading `catalog.mods` directly; skipped
  entries go to `console.warn` (the app logs them).
- Keep the existing error box for an unusable catalog.

## Out of scope (say so in the report; do not attempt)

- Download state (spinner / check mark / Retry + error), auto-install and
  `sha256` verification: the browser owns the download, and release assets
  cannot be `fetch()`ed (CORS). The card keeps the NotStarted look only.
- Catalog source picker and Refresh: the page serves exactly one catalog.
- Light theme: the app hardcodes Dark.

## Verification

- `cd ModCatalog/worker && node --test` — all green (the existing 105 +
  your new `catalog-lib.test.js`).
- `cd ModCatalog && python -m unittest discover -s tests` still green
  (you should not need Python changes).
- `QwenWorkspace`: `dotnet test ModManager.Tests` green after Step 0.
- Browser check: copy `mod-contract/tags.json` to `site/tags.json`, serve
  with `python -m http.server <port> --directory site` (run it in the
  background and stop it afterwards; delete `site/tags.json` after), open
  `index.html` in the built-in browser. Check: no console errors; cards at
  desktop width and at 375px; hover; card click opens the lightbox and the
  download button does not; Esc / scrim / ✕ close; chips and search filter
  and update the count; a mod without a cover shows the hashed-colour
  letter. Use `site/catalog.json` (real data) and, for a mod with tags and
  a game version, a temporary local catalog served from the same folder —
  never commit or keep test data in `site/`.
- Optional visual cross-check: run the app against the same catalog (Browse
  tab → add the local URL in Settings) and compare a full-window screenshot
  using the recipe in `AGENT_DOCS/tooling.md`.

## Docs to update

- `ModCatalog/AGENTS.md` — "The web page": the lightbox, filter panel,
  `catalog-lib.js`, `tags.json` use, and the out-of-scope list.
- `QwenWorkspace/AGENT_DOCS/layout-browse.md` — Step 0 only.
- Code comments: only where something is genuinely non-obvious, describing
  the code itself — never plans, history or alternatives (both repos' rule).

## Report back

Files changed per repo, test counts, what you verified in the browser (and
how), any deviation from this plan and why, and anything left undone.
