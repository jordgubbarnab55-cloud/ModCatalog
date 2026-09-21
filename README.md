# Mod Catalog

A public mod catalog, served as static files via **GitHub Pages**, that does
two things:

1. **Web page** — a browsable mod list (same card layout as ModManager's
   Browse/Discover tab) for people who don't want to install ModManager.
2. **Manifest** — `catalog.json`, the same catalog schema ModManager's Browse
   tab speaks, so ModManager can use this repo as a source.

## The zips are the source of truth

Every mod is a `.zip` in `assets/` containing a UE packaged container whose
`.utoc` carries a **metadata trailer** (the ModManager trailer format:
`"UEMODMET"` magic + JSON payload with `title`/`author`/`description`/
`version`/`guid` and an embedded cover image). Nothing about a mod is typed
into `catalog.json` by hand.

`catalog.json` and `assets/covers/` are **generated artifacts**:

- **GitHub Actions** (`.github/workflows/build-catalog.yml`) runs
  `build.py` on every push that touches `assets/**/*.zip`, regenerates the
  manifest + covers, and commits the result back.
- `build.py` **rejects** any package without exactly one `.utoc` and a valid
  trailer — the push goes red and the catalog is left unchanged. Trailer
  validation mirrors the C# reader in the ModManager workspace
  (`io-trailer`), so packages accepted here are packages ModManager can read.

The schema is URL-shaped (`file`/`cover` resolve relative to the catalog URL,
and absolute URLs work), so a package can later live on any host — a CDN,
release assets, an S3 bucket — with no other changes.

## Adding a mod

1. Zip your packaged container (`.utoc`/`.ucas`/`.pak`) with a valid trailer
   (write one with ModManager's Development tab, or `make_examples.py` for
   experimenting).
2. Drop the `.zip` into `assets/` and push.
3. That's it — Actions regenerates the catalog and covers automatically.

## Files

```
build.py                  generator: assets/*.zip -> catalog.json + covers (CI runs this)
trailer.py                stdlib read/write/validate for the .utoc trailer format
make_examples.py          dev tool: builds sample packages from a real UE pair
                          (python make_examples.py <pair-dir> [cover.jpg])
catalog.json              generated manifest — do not edit
index.html                the GitHub Pages site (renders catalog.json)
assets/
    *.zip                 mod packages (the source of truth)
    covers/               generated cover images (from the trailers)
.github/workflows/        build-catalog.yml
```

## Catalog schema (what ModManager consumes)

Top level: `{ "name", "description", "mods": [ ... ] }`. Each mod entry:

| Field         | Meaning                                                       |
|---------------|---------------------------------------------------------------|
| `id`          | The trailer GUID (stable identity across versions)            |
| `name`        | Trailer title                                                 |
| `author`      | Trailer author                                                |
| `version`     | Trailer version (shown as `v{version}`)                       |
| `description` | Trailer description                                           |
| `file`        | Package URL — relative to the catalog, or absolute (a `.zip`) |
| `size`        | Package size in bytes                                         |
| `cover`       | Cover image URL, extracted from the trailer                   |

## Using it from ModManager

Open **Browse** in ModManager and set the server URL to:

```
https://jordgubbarnab55-cloud.github.io/ModCatalog/catalog.json
```

then click **Refresh**. Downloads stream straight from GitHub.
