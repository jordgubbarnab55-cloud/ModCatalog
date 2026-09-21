# AGENTS.md

ModCatalog — a **trailer-driven public mod catalog**. Static site on GitHub
Pages + a JSON manifest, both *generated* from the mod packages themselves.
Serves two consumers: browsers (the web page, for people who don't want
ModManager) and **ModManager's Browse tab** (via the manifest, which speaks
the exact `catalog.json` schema its `Net/CatalogClient` parses).

## Core contract: the zips are the source of truth

- A mod = one `.zip` in `assets/` containing a UE packaged container whose
  `.utoc` carries a **metadata trailer** (`"UEMODMET"` magic + compact
  UTF-8 JSON payload: `schema`/`title`/`author`/`description`/`version`/
  `guid` + optional base64 `image` PNG/JPEG ≤ 4 MiB).
- `catalog.json` and `assets/covers/` are **generated artifacts — never edit
  them by hand**. All mod data (including the `id`, which is the trailer
  GUID) is derived from the packages. The top-level catalog
  `name`/`description` live as constants in `build.py`.
- **Packages without a valid trailer are rejected**: `build.py` exits 1 and
  leaves the catalog untouched; in CI the push goes red. No overrides, no
  hand-filled entries — if a package is rejected, fix the package.
- The schema is URL-shaped: `file`/`cover` resolve **relative to the catalog
  URL**, absolute URLs work too. Moving packages to any host (CDN, releases,
  S3) means only changing `file` — nothing in the site or app.

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
  `ModMetadata.cs`, `TrailerOps.cs`), used by ModManager. When in doubt about
  the format, the C# + its tests win. **Cross-check Python-written trailers
  with C# before trusting them** (scratch console app with a
  `ProjectReference` to `io-trailer.csproj`, call `TrailerOps.ReadTrailer` —
  done this way in 2026-09 for all three example packages).
- Trailers are normally written by **ModManager's Development tab**
  (drop the container folder in the Package drop zone).

## Files

```
build.py                  generator: assets/*.zip -> catalog.json + assets/covers/
trailer.py                stdlib trailer read/write/validate (format twin of io-trailer)
make_examples.py          dev tool: python make_examples.py <pair-dir> [cover.jpg]
                          builds sample packages from a REAL .utoc/.ucas/.pak triple
catalog.json              GENERATED manifest — do not edit
index.html                GitHub Pages site — static renderer of catalog.json
assets/
    *.zip                 mod packages (source of truth)
    covers/{guid}.png|jpg GENERATED cover images, named by trailer GUID
.github/workflows/build-catalog.yml
```

## CI: how the catalog regenerates

`build-catalog.yml` runs `python build.py` (Python 3.12, **no pip installs —
everything is stdlib**) and commits the generated changes back. Rules that
matter:

- Triggered by `push` matching **`assets/**/*.zip` only**. The bot's commit
  touches `catalog.json` + `assets/covers/`, which never match the filter →
  **no re-trigger loops**. Don't widen the path filter.
- `workflow_dispatch` is available for testing; use it after changing
  `build.py`/`trailer.py` (those paths don't trigger the workflow).
- The commit-back check is deliberately scoped:
  `git status --porcelain catalog.json assets/covers` — a whole-tree check
  broke once when Python left `__pycache__/` (now gitignored, but the scoping
  is the real fix). `git add` is likewise path-scoped.
- Generator output is **deterministic** (sorted entries, stable JSON) so an
  unchanged package set produces a byte-identical catalog → no-op runs, no
  churn commits.
- `build.py` also **prunes stale covers**: `assets/covers/*.png|jpg` not
  referenced by the current manifest are deleted.
- One `.utoc` per zip, enforced (0 or 2+ → reject).

## The web page

`index.html` is a single self-contained file: no build step, no framework,
no CDN, no external JS. It `fetch('catalog.json', {cache:'no-store'})`
same-origin at load and renders cards dynamically — **zero mod data in the
HTML**. Design must mirror ModManager's `BrowseModCard` (the cards there are
the reference): Adonis dark palette (window `#2A2B34`, card surface
`#32323F` / hover `#3D3D4C`, fg `#F0F0F0` @ 75% secondary, accent `#206BD4`
/ hover `#3C81E2`), 90×90 cover with accent letter fallback, title 14
semibold, `author • v{version}` + description 12, and a 52×52 solid-accent
square with the Lucide inbox icon + centered size hint (2 cards/row, 1 on
narrow screens). The download button is a plain `download` link — the zip is
fetched **only on click**, never at render time (hard requirement: the page
must not make browsers download package bytes for browsing).

## Adding a mod (the whole flow)

1. Zip the packaged container with a valid trailer (ModManager Development
   tab, or `make_examples.py` for experiments — it strips any pre-existing
   trailer before appending, so it works on already-trailed pairs).
2. Drop the `.zip` into `assets/`, push. CI does the rest.

## Using it from ModManager

Browse tab → server URL:
`https://jordgubbarnab55-cloud.github.io/ModCatalog/catalog.json` → Refresh.
ModManager's `CatalogClient` is lenient (missing `accent`/`size`/`cover`
fine), so the generated manifest (which has no `accent`) needs no app
changes.

## Environment & tooling notes (this machine)

- Git identity is set **globally** to the GitHub account
  (`jordgubbarnab55-cloud` + noreply email); HTTPS auth goes through
  **Git Credential Manager** (the account is logged in via
  `git-credential-manager github login`). No tokens in any config.
- `gh` CLI (no `gh auth` set up) works by borrowing a GCM token:
  `TOKEN=$(printf "protocol=https\nhost=github.com\n" | git-credential-manager get | grep '^password=' | cut -d= -f2); GH_TOKEN="$TOKEN" gh ...`
- GitHub **Pages** (legacy, `main` branch, `/`) takes ~1 min per build; poll
  `gh api repos/jordgubbarnab55-cloud/ModCatalog/pages` until
  `"status":"built"`.
- **Windows Python 3.14 is cp1252-hostile**: read JSON/text with
  `encoding="utf-8"` explicitly; console output of non-ASCII (em dashes)
  mangles but files on disk are fine.
- Path trap: the file tool's `/tmp` is **not** Git Bash's
  `/tmp` (`C:\Users\Admin\AppData\Local\Temp`); Windows-native Python
  resolves neither. Use workspace-relative or absolute paths.
- CI runner quirk observed: `actions/checkout` + Python leaves
  `__pycache__/` behind — hence the `.gitignore` and the scoped status check.
- Sibling repos in `C:\Users\Admin\Documents\`: `QwenWorkspace`
  (ModManager + `io-trailer` + `example_server` + the
  `example_mod/` pair the sample packages are built from) — separate git
  repo, do not assume it's on the same remote.
