# Architecture

## Components

| Component | Role |
|---|---|
| GitHub Releases | Storage. One release per mod (`mod-<slug>-<hex>`), plus one fixed `inbox` release for incoming uploads |
| GitHub Actions | Processing. Drains the inbox, validates, re-homes packages, regenerates `site/catalog.json`, deploys Pages |
| GitHub Pages | Serves `site/` (the page, `config.json`, `catalog.json`) and nothing else; `downloads.json` (per-mod download counts, generated at deploy time) and `tags.json` ride along on each deploy |
| Cloudflare Worker (`worker/`) | Discord interactions, token and login-code auth, streaming upload pass-through, runner event mirror |
| D1 (`DB`) | Tokens, login codes, forum thread mapping, seen event ids |
| KV (`TOKENS`) | Upload quota counters, inbox release-id cache |
| ModManager's Browse tab | Reads `catalog.json`, downloads release assets |

## Data flow

```
browser / ModManager --upload--> Worker --stream--> release "inbox"
                                    |                    |
                                    +--dispatch--> process-inbox.yml
                                                         |
                       reassemble, verify, resolve, rewrite trailer
                                                         |
              release mod-<slug>-<hex> (zip + cover) + site/catalog.json
                                                         |
                       Pages deploy  -->  notify --> Worker /catalog/events --> Discord
```

The Worker never parses a package: free-plan CPU is 10 ms and client-supplied
ids are not trusted. Everything that needs the package bytes runs on the
runner (`docs/inbox-pipeline.md`).

## Core contract

- **The release assets are the source of truth.** A mod is a `.zip` release
  asset in its per-mod release. The package is a UE container whose `.utoc`
  carries a metadata trailer (`docs/trailer-and-contract.md`).
- **`site/catalog.json` is generated.** Every field, including the `id`, is
  derived from packages. Top-level catalog `name` and `description` come from
  `site/config.json` `title`/`description` through
  `build.load_catalog_identity` (defaults `DEFAULT_CATALOG_NAME` and
  `DEFAULT_CATALOG_DESCRIPTION` when absent or blank); `python build.py
  retitle` re-applies only those two.
- **Packages without a valid trailer are rejected** with a clear reason and
  removed from the inbox. One bad package never blocks the rest of a run.
  There are no hand-filled entries; fix the package.
- **Entry URLs are stable release URLs:**
  `https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>`. They
  302 to short-lived signed URLs, which are never stored. The schema is
  URL-shaped, so moving packages to another host changes `file` only.
- **No package zips or cover images in git.** Releases are the storage and
  Pages serves only the site plus `catalog.json`.

## Limits that shape the design

| Limit | Value | Consequence |
|---|---|---|
| Worker request body | 100 MB | Files over 100 MB are uploaded as parts of at most 90 MB |
| Worker CPU (free plan) | 10 ms | No parsing, hashing or zipping in the Worker |
| Discord interaction ACK | 3 s | `/discord` handlers make no GitHub calls |
| GitHub release asset | 2 GiB | Built package zip and reassembled sets are capped here |
| Daily upload quota per user | 2 GiB by default | Worker answers 429 |
| Worker subrequests (free) | 50 | Event mirror uses at most 3 per event, 10 events per request |
| GitHub `GITHUB_TOKEN` (fine-grained) | expires, 1 year max | Expired token makes the Worker answer 502 |

KV is eventually consistent; a slightly late quota count is acceptable.

## Where things live

| Topic | Doc |
|---|---|
| Identifier, tag, ownership, verified authors | `docs/identity-and-ownership.md` |
| Inbox to catalog flow | `docs/inbox-pipeline.md` |
| `build.py` commands and validation | `docs/build-pipeline.md` |
| Workflows | `docs/workflows.md` |
| Worker | `docs/worker.md` |
| Page and upload flow | `docs/site.md`, `docs/upload-flow.md` |
| Trailer and shared contract | `docs/trailer-and-contract.md` |
