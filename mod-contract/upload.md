# Upload endpoint contract

How a client publishes a package to a catalog server. ModCatalog's Worker
(`worker/README.md` there) implements it; ModManager's `UploadClient` and
ModCatalog's `site/upload.html` are clients. Any server implementing the same
requests and status codes works with both.

Every request: `POST <endpoint>`, `Authorization: Bearer <token>`,
`Content-Length` set, body ≤ 100 MB.

## Zip mode

One request: `X-Filename: <name>.zip`, body = the zip (≤ 100 MB).

## Raw mode (loose files)

The set must pass the loose-file rules in `package-spec.md`. One upload id
(a UUID) per set, on every request as `X-Upload-Id`.

1. The manifest: `X-Filename: manifest.json`, `X-File-Idx: -1`,
   `X-Part-Idx: 0`, `X-Part-Count: 1`, body:
   ```json
   { "files": [ { "name": "mod.utoc", "sha256": "<hex of the whole file>", "parts": 1 } ] }
   ```
   `files` is in package order (`.utoc`, `.ucas`, `.pak`, `.sig`).
2. Every file, split into contiguous slices of at most 90 MB
   (`parts = max(1, ceil(size / 90 MB))`): `X-Filename: <file name>`,
   `X-File-Idx: <index in files>`, `X-Part-Idx: <j>`, `X-Part-Count: <parts>`.

## Responses

| status | meaning | client action |
|---|---|---|
| 202 | accepted (for raw mode: this request) | continue; after the last one, poll the catalog |
| 400 | bad name or headers | fix the request |
| 401 | missing/unknown/revoked token | get a new token |
| 411 | no Content-Length | — |
| 413 | body over 100 MB | split |
| 429 | daily byte quota used up | retry tomorrow |
| 502 | the server's storage backend failed; nothing stored | do not retry blindly |
| 503 | the server's inbox is not set up | contact the maintainer |

A raw set stops at the first non-202. The catalog shows the mod once the
server has processed the package (ModCatalog: a few minutes).
