# Upload endpoint contract

How a client publishes a package to a catalog server. ModCatalog's Worker
(`worker/README.md` there) implements it; ModManager's `UploadClient` and
ModCatalog's web page (`site/index.html`, the upload modals) are clients.
Any server implementing the same requests and status codes works with both.

Every upload request: `POST <endpoint>`, `Authorization: Bearer <token>`,
`Content-Length` set, body ≤ 100 MB.

## Verified authors

A server may publish **verified** authors (ModCatalog does; its catalog says
`"verifiedAuthors": true`, see `catalog.md`). The token identifies an account,
and the server — not the package, not `metadata.json` — decides what the
stored trailer says:

- `author` = the account's name (ModCatalog: the Discord `username`, not the
  display name or a server nickname) **as of this upload**;
- `identifier` = `{accountId}.{Title}` with all whitespace removed (the
  trailer's cosmetic identifier, with the account id in place of the author;
  recomputed on every upload — the GUID stays the real identity).

This applies to **every** accepted package: zip mode, a set without
`metadata.json`, a set with it, and the server's own admins. The package is
re-written with these fields even when its author already matches. Earlier
versions' stored packages are immutable and
keep the name they were uploaded with; a server may update the *catalog*
entries' `author` when the account is renamed.

### `GET <endpoint root>/whoami`

`Authorization: Bearer <token>` → `200 {"discordId": "…", "username": "…"}`
(ModCatalog's field names; another server's account id field may differ, a
client only needs the name), or `401 {"error": "…"}` with a human-readable
reason (unknown, revoked, or minted before the server recorded names — mint a
new token). CORS as for `/upload` (`GET`, `Authorization`). A client uses it
to validate a token and to show the name the upload will carry.

On the server the account name reaches the pipeline through the inbox asset
names, which the upload endpoint builds from the token (never from request
headers); a client cannot influence it.

## Zip mode

One request: `X-Filename: <name>.zip`, body = the zip (≤ 100 MB). No upload
id. The package's own trailer fields are used (apart from the ones a server with
verified authors overrides, above). (ModManager's `UploadClient` uses
this mode.)

## Set mode

One upload id (a UUID) per set, on every request as `X-Upload-Id`. A set is
announced by a manifest and made of:

- **the package**, either the loose files (`.utoc`, `.ucas`, `.pak`, optional
  `.sig`, which must pass the loose-file rules in `package-spec.md`) **or
  exactly one `.zip`** (which must pass the zip rules there);
- optionally **`metadata.json`**, the trailer metadata the server writes into
  the package.

The browser sends the package bytes unchanged; the server writes the final
trailer (`.utoc` metadata trailer, `trailer-spec.md`).

1. The manifest: `X-Filename: manifest.json`, `X-File-Idx: -1`,
   `X-Part-Idx: 0`, `X-Part-Count: 1`, body:
   ```json
   {
     "files": [ { "name": "mod.utoc", "sha256": "<hex of the whole file>", "parts": 1 } ],
     "metadata": { "sha256": "<hex of metadata.json>" }
   }
   ```
   `files` is in package order (`.utoc`, `.ucas`, `.pak`, `.sig`; or the one
   `.zip`). `metadata` is present only when a `metadata.json` part follows;
   the server waits for it and verifies the hash.
2. Every file, split into contiguous slices of at most 90 MB
   (`parts = max(1, ceil(size / 90 MB))`): `X-Filename: <file name>`,
   `X-File-Idx: <index in files>`, `X-Part-Idx: <j>`, `X-Part-Count: <parts>`.
3. The metadata (optional, single part): `X-Filename: metadata.json`,
   `X-File-Idx: -2`, `X-Part-Idx: 0`, `X-Part-Count: 1`.

### `metadata.json`

```json
{
  "title": "Mod name", "description": "…", "version": "1.2", "game_version": "28.02.0",
  "tags": ["Skin"], "author": "Someone",
  "guid": "<the package's existing GUID>",
  "image": { "mime": "image/png", "data": "<base64>" }
}
```

- The fields and limits are those of the trailer payload (`trailer-spec.md`);
  `identifier` is derived (`Author.Title`, whitespace removed). The server
  treats the file as untrusted input and rejects the set when it violates the
  trailer's metadata schema. A server with verified authors (above) overrides
  `author` and `identifier`; clients still send the name they show.
- `guid` is optional. Without it the package keeps its existing GUID (a new
  one is generated when it has no trailer). A `guid` that is not the
  package's existing GUID rejects the set: changing a mod's identity is done
  in ModManager, not through the catalog.
- `image` absent keeps the package's cover; `"image": null` removes it; an
  object replaces it (PNG or JPEG, ≤ 4 MiB).
- A set **without** `metadata.json` keeps the package's own trailer fields
  (the package must already carry a valid trailer), apart from the fields a
  server with verified authors overrides.
- A loose set is zipped by the server; for a `.zip` the server rebuilds the
  package from the zip's set members and the rewritten `.utoc` (other members
  are dropped).

## Responses

| status | meaning | client action |
|---|---|---|
| 202 | accepted (for a set: this request) | continue; after the last one, poll the catalog |
| 400 | bad name or headers | fix the request |
| 401 | missing/unknown/revoked token | get a new token |
| 411 | no Content-Length | — |
| 413 | body over 100 MB | split |
| 429 | daily byte quota used up | retry tomorrow |
| 502 | the server's storage backend failed; nothing stored | do not retry blindly |
| 503 | the server's inbox is not set up | contact the maintainer |

A set stops at the first non-202. The catalog shows the mod once the server
has processed the package (ModCatalog: a few minutes); a package or metadata
the server rejects never appears, and the 202 does not report it.
