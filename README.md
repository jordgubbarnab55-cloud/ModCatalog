# Mod Catalog

A public mod catalog and upload system, running entirely on free tiers:
**GitHub** (Actions + Releases + Pages) and one **Cloudflare Worker**.

1. **Web page** — `https://jordgubbarnab55-cloud.github.io/ModCatalog/`, a
   browsable mod list (same card layout as ModManager's Browse/Discover tab)
   for people who don't want to install ModManager.
2. **Manifest** — `catalog.json` (served from Pages at the same base URL),
   the same catalog schema ModManager's Browse tab speaks.
3. **Uploads** — Discord `/token` mints a personal token; the ModManager app
   or the web page's upload dialog (`index.html`) then POSTs the package to the Worker,
   which streams it into a GitHub **release** (the storage), and a workflow
   validates, publishes, and redeploys the catalog. You can upload a ready-made
   `.zip` **or the raw container files** (`.utoc`/`.ucas`/`.pak`, part-split
   when a file is over 100 MB) plus optional metadata — the browser sends the
   package unchanged and the workflow writes the metadata trailer and zips the
   set on the runner. The
   web page even writes the `.utoc` metadata trailer for you if it's missing.

## The release assets are the source of truth

Every mod is a `.zip` **release asset** (a `mod-<identifier slug>-<hash>`
release, one per mod; the trailer `identifier`, minted on the first upload as
`{discordId}.{Title}` and then locked, is the mod's identity)
whose package contains a UE packaged container whose `.utoc` carries a
**metadata trailer** (the ModManager trailer format: `"UEMODMET"` magic +
JSON payload with `title`/`author`/`description`/`version`/`identifier`/`guid` and an
embedded cover image). Nothing about a mod is typed into `catalog.json` by
hand.

`site/catalog.json` is a **generated artifact**:

- **`Process inbox`** (`.github/workflows/process-inbox.yml`) drains the
  `inbox` release (the Worker's staging area), validates each package,
  re-homes it to its mod's release, merges the entry into `site/catalog.json`
  and deploys Pages — all in one run.
- **`Rebuild catalog`** (`.github/workflows/rebuild.yml`) regenerates the
  whole file from scratch from the `mod-*` releases, so a lost or corrupt
  catalog is recoverable.
- `build.py` (Python, **stdlib only**) rejects invalid packages (bad zip,
  missing/multiple `.utoc`, no valid trailer, no `.ucas`/`.pak`, over
  100 MB) with a clear reason; one bad package never blocks the others.
  Trailer validation mirrors the C# reader in the ModManager workspace
  (`io-trailer`), so packages accepted here are packages ModManager can read.

Covers are release assets too — they never consume Pages bandwidth, and
zips don't either. Only the site (a few KB) and `catalog.json` live on
Pages.

## Adding a mod

1. In Discord, run **`/token`** and copy the token it shows (treat it like
   a password; `/token` again replaces it, `/token revoke` kills it). The
   token carries your Discord username, which becomes the mods' author; a
   token minted before that was recorded is rejected — mint a new one.
2. Upload it — either as a `.zip` or as the raw container files
   (`.utoc`/`.ucas`/`.pak`), from ModManager's upload flow (against the
   Worker API documented in `worker/README.md`) or from the web page at
   `<catalog URL>` ("Upload a mod": paste the token once, pick the package,
   edit the metadata, confirm). Files over 100 MB are automatically
   part-split by the client. The page's editor prefills from the package's
   metadata trailer (or starts empty) and the catalog writes your edited
   metadata into the stored package.
3. That's it — the `Process inbox` workflow runs within a minute and the
   mod appears in the catalog.

Limits: **100 MB per upload** (one file or one part; Cloudflare free-plan
request-body limit) — raw file sets may be up to GitHub's **2 GiB**
per-asset limit, and the daily quota is **2 GiB per user**;
stored packages are never overwritten (re-uploading a version you already
published with changed files is stored alongside it and becomes the current
download; an unchanged re-upload is rejected), and the same files with the
same title and version under another identifier are rejected as a duplicate
of the existing mod. A new upload mints the mod's identifier
`{discordId}.{Title}` (an identifier you already have is rejected: update that
mod instead); an update (`metadata.json` `identifier`) must target one of your
own mods (admins from `ADMIN_DISCORD_IDS` bypass this). The author shown is
always your Discord **username**, whatever the package says: the catalog
rewrites the stored trailer's `author`, `identifier` and (fresh) `guid`.

## Files

```
build.py                  generator + pipeline (stdlib only): process / rebuild
trailer.py                stdlib read/write/validate for the .utoc trailer format
make_examples.py          dev tool: builds sample packages from a real UE pair
site/
    index.html            the GitHub Pages site (renders catalog.json)
    upload.html           redirect to index.html#upload (old links)
    upload-flow.js        the upload modals (token, package, editor, confirm)
    upload-editor.js      the metadata editor (ModManager's, on the web)
    modal.js              modal helper; zip-lib.js: reads a zip's .utoc only
    upload-lib.js         pure helpers behind the flow (node --test-able)
    config.json           {"title": "<catalog title>", "uploadUrl": "<worker url>"}
                          — the deployer's settings (SETUP.md step 12)
    catalog.json          generated manifest — do not edit
worker/                   Cloudflare Worker: Discord /token + streaming /upload
legacy-assets/            the original example zips (deleted after one-off seeding)
.github/workflows/        process-inbox.yml, rebuild.yml, seed-legacy.yml,
                         deploy-site.yml  (+ .github/actions/commit-and-deploy)
tests/                    offline unit tests for the pipeline (unittest)
```

## Catalog schema (what ModManager consumes)

Top level: `{ "name", "description", "mods": [ ... ] }` (`name`/`description`
from `site/config.json` `title`/`description`). Each mod entry
(one per mod identifier, pointing at the most recently uploaded version):

| Field         | Meaning                                                       |
|---------------|---------------------------------------------------------------|
| `id`          | The trailer identifier (permanent identity across versions and renames) |
| `name`        | Trailer title                                                 |
| `author`      | The uploader's Discord username, **verified** (the catalog sets `"verifiedAuthors": true`); follows renames on the owner's uploads |
| `version`     | Trailer version (shown as `v{version}`)                       |
| `description` | Trailer description                                           |
| `file`        | Stable release-asset URL of the package (a `.zip`)           |
| `size`        | Package size in bytes                                         |
| `cover`       | Stable release-asset URL of the cover image (if the trailer has one) |
| `sha256`      | SHA-256 of the package zip                                    |
| `uploader`    | The Discord user id of the owner                              |
| `updated`     | ISO-8601 UTC timestamp of the newest upload                   |

`file`/`cover` are absolute GitHub release URLs; they 302-redirect to
short-lived signed storage URLs. **Always store the stable URL.**

## Using it from ModManager

Open **Browse** in ModManager and set the server URL to:

```
https://jordgubbarnab55-cloud.github.io/ModCatalog/catalog.json
```

then click **Refresh**. Downloads follow GitHub's redirect and stream
straight from the release assets.

## Setup

New maintainers: see **`SETUP.md`** (ordered runbook) and **`HANDOFF.md`**
(what is verified, what is not, and what to fill in).
