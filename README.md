# Mod Catalog

A tiny public mod catalog, served as static files via **GitHub Pages**, that
does two things:

1. **Web page** — a browsable mod list (same card layout as ModManager's
   Browse/Discover tab) for people who don't want to install ModManager.
2. **Manifest** — `catalog.json`, the same catalog schema ModManager's Browse
   tab speaks, so ModManager can use this repo as a source.

## Layout

```
catalog.json          the manifest (schema below)
index.html            the GitHub Pages site (fetches catalog.json, same-origin)
assets/
    *.zip             mod packages, stored in the repo for now
    covers/*.jpg      cover images
```

Packages live in this repo as plain assets today, but the schema is URL-based:
`file` and `cover` are resolved **relative to the catalog URL**, and absolute
URLs are allowed too — so moving packages to any other host (CDN, release
assets, an S3 bucket, a direct server) only requires editing the entries,
nothing else.

## Catalog schema

Top level: `{ "name", "description", "mods": [ ... ] }`. Each mod entry:

| Field         | Meaning                                                       |
|---------------|---------------------------------------------------------------|
| `id`          | Stable identifier (unique per catalog)                        |
| `name`        | Display name                                                  |
| `author`      | Author / team                                                 |
| `version`     | Version string (shown as `v{version}`)                        |
| `description` | Short description (one line on the card)                      |
| `file`        | Package URL — relative to the catalog, or absolute (a `.zip`) |
| `size`        | Package size in bytes (shown on the card)                     |
| `cover`       | Optional cover image URL (relative or absolute)               |
| `accent`      | Optional `#RRGGBB` accent for the letter placeholder          |

## Adding a mod

1. Drop the `.zip` into `assets/` (or host it anywhere and use an absolute URL).
2. Optionally add a cover image to `assets/covers/`.
3. Add an entry to `catalog.json` (`size` = the file's byte size).
4. Commit & push — Pages redeploys automatically.

## Using it from ModManager

Open **Browse** in ModManager and set the server URL to:

```
https://jordgubbarnab55-cloud.github.io/ModCatalog/catalog.json
```

then click **Refresh**. Downloads stream straight from GitHub.
