# ModCatalog Worker

Cloudflare Worker (free plan). The Discord interaction flow, the #mods
buttons, the D1 token/login-code auth internals, the forum-channel setup
and the test suite are documented in [`docs/worker.md`](../docs/worker.md).

## `GET /whoami`

Bearer token → `200 {"discordId", "username"}`; the web page uses it to
validate a token and to show the author name the upload will carry.
`401 {"error"}` for a missing / unknown / revoked / expired token
(rejected the same way on `/upload`).

## Upload API contract (for the ModManager app)

The client-facing contract is `mod-contract/upload.md` (shared with
ModManager's `UploadClient`); this section is the Worker's side of it.

### Shape 1 — a ready-made .zip package

```
POST <worker-url>/upload
Authorization: Bearer <token from /token>
X-Filename: <name>.zip          # required, must end in .zip
<body: the raw zip bytes>
```

### Shape 2 — an upload set (no client-side zipping or trailer writing)

Send the `.utoc` / `.ucas` / `.pak` (+ optional `.sig`) files **or exactly one
`.zip`** directly, plus optional metadata (the workflow writes the trailer
and zips the set on the runner). Each file goes through the same endpoint,
**part-split into ≤ 90 MB slices when a file is over 100 MB** (7z-style
contiguous slices — plain byte chunks, concatenated = the original file).
Every upload of the set carries the same `X-Upload-Id`, plus the set's
`manifest.json` upload (and the optional `metadata.json`):

```
POST <worker-url>/upload
Authorization: Bearer <token from /token>
X-Upload-Id: <uuid>            # one per set; switches the Worker into raw mode
X-Filename: <file name>        # .pak/.ucas/.utoc/.sig or .zip, "manifest.json", "metadata.json"
X-File-Idx:  <i>               # 0-based file index ("-1" = the manifest, "-2" = metadata.json)
X-Part-Idx:  <j>
X-Part-Count: <n>
Content-Length: (required)
<body: this slice of the file>
```

`manifest.json` (uploaded with `X-File-Idx: -1`, `X-Part-Idx: 0`,
`X-Part-Count: 1`):

```json
{
  "files": [ { "name": "mod.utoc", "sha256": "<hex of the FULL file>", "parts": 2 } ],
  "metadata": { "sha256": "<hex of metadata.json>" }
}
```

The `sha256` is of the full, reassembled file (the workflow verifies it).
Order the `files` entries the way you want them inside the package zip.
`metadata` is present only when a `metadata.json` upload follows
(`X-File-Idx: -2`, `X-Part-Idx: 0`, `X-Part-Count: 1`, one request); its body
is the trailer metadata (`title`, `author`, `description`, `version`,
`game_version`, `tags`, optional `identifier` (= update that mod; absent =
a new mod), optional `image`; a `guid` is ignored; schema and semantics in
`mod-contract/upload.md`). The workflow validates it with the trailer's
limits, writes it into the `.utoc` and rejects the set when it is invalid, an
update targets an unknown mod or someone else's, or a new mod's minted
identifier already exists. A set without metadata keeps its package's own
fields, except that `author`, `identifier` and `guid` are always forced.

| Status | Meaning |
|--------|---------|
| `202`  | Queued. Body was streamed to the `inbox` release and the processing workflow was woken. The mod appears in `catalog.json` within a few minutes (raw sets: after all parts arrive). |
| `401`  | Missing / unknown / revoked / expired token. |
| `411`  | `Content-Length` header missing (required). |
| `413`  | A single upload over 100 MB (Cloudflare free-plan request-body limit) — split the file into parts. |
| `429`  | Daily per-user byte quota exceeded (default 2 GiB/day, UTC). |
| `400`  | Bad name/headers (zip mode: not a .zip; set mode: not .pak/.ucas/.utoc/.sig/.zip, or bad part/manifest/metadata headers). |
| `502`  | GitHub failed (token wrong/expired, or upload/dispatch error). Nothing was stored; do not retry blindly — check the token. |
| `503`  | The `inbox` release does not exist yet; run the `Process inbox` workflow once. |

Notes:

- The request body is **streamed, not buffered**: do not wait for a full
  response before uploading; a `202` means GitHub accepted the bytes.
- **The 100 MB limit is per upload (one part); the final package may be up
  to GitHub's per-asset limit (2 GiB)** — that is the whole point of raw
  file sets. Zip mode keeps the 100 MB per-package cap.
- Sets: the `process-inbox` workflow waits for the complete set
  (manifest + every part + the declared metadata), reassembles on the
  runner, verifies the per-file sha256, writes the metadata trailer, zips
  the set, then validates and re-homes as usual.
  Stalled sets are swept after 7 days.
- The response and CORS headers are safe for both the native app (no
  `Origin` sent) and a web page: `Access-Control-Allow-Origin` is the
  `ALLOWED_ORIGIN` var only; allowed headers are
  `Authorization, Content-Type, X-Filename, X-Upload-Id, X-File-Idx,
  X-Part-Idx, X-Part-Count` (extra headers are accepted by the Worker).
- Asset names in the inbox start with the **uploader stamp**
  `<discordId>-<hex>`, where `<hex>` is the lowercase hex of the UTF-8 bytes of
  the token's username (hex survives `sanitizeFilename` and the `__` split for
  any account name). The Worker builds it from the token record — no request
  header can set it. So: `<stamp>__<ts>__<safe-filename>.zip` (zip mode) or
  `<stamp>__<uploadId>__f<i>__p<j>of<n>__<safe-filename>` +
  `<stamp>__<uploadId>__manifest.json` (+ `…__metadata.json`) (set mode); the
  workflow reads the real GUID out of the package and re-homes it. A `__`
  inside a file name is collapsed to `_` (it separates the fields). Names
  without a valid stamp are ignored by the workflow.
- **Verified authors**: the workflow rewrites every accepted package's trailer
  with `author` = that username and `identifier` = `<discordId>.<Title without
  whitespace>`, whatever the package or `metadata.json` says (see
  `mod-contract/upload.md`).

## Minimum GitHub token permissions (for `GITHUB_TOKEN`)

- **Fine-grained**, resource owner: your account, repository access:
  **only this repo**.
- Repository permissions: **Contents: Read and write**,
  **Actions: Read and write** (metadata read is automatic).
- Fine-grained tokens **expire** (max 1 year). When this token expires,
  uploads start failing with `502` — set a calendar reminder at creation.

## Catalog outcome events (`/catalog/events`)

`build.py notify` (the `process-inbox` / `rebuild` workflows) POSTs a run's
outcome events here: `X-Catalog-Signature` = the hex HMAC-SHA256 of the raw
body keyed with the secret `CATALOG_CALLBACK_SECRET`, plus a fresh `ts` in
the signed payload, at most 10 events per request. The Worker verifies the
signature (constant-time) and the timestamp (|now - ts| <= 300 s, else 401)
and mirrors each event into Discord — one failing event never aborts the
others: it stays unrecorded and is reported `ok: false` so the runner can
retry it.

- `published` — one forum thread per mod (D1 `mod_threads`, keyed on the
  lowercased identifier): a **new thread** on first sight (name = the title,
  first message `<@uploaderId> published **title** vVERSION` + the description
  + a link to `SITE_URL`, one embed with the cover as `image` when set and
  the footer `mod-id: <identifier>`, the catalog tags applied through the var
  `FORUM_TAG_IDS` — a JSON object catalog-tag -> forum tag id, unknown tags
  ignored, max 5) — and a **follow-up message** in the existing thread for
  updates. A thread deleted on Discord (404/403) is re-created and the
  mapping replaced.
- `rejected` — a notice in the var `NOTICES_CHANNEL_ID` (a text channel;
  blank = a log line only). No DMs.

Mirrored event ids go into `seen_events` (a redelivered event is a no-op;
rows are opportunistically swept at 30 days old). Every outgoing payload
sets `allowed_mentions: {parse: [], users: [uploaderId]}` and user-supplied
text (title, version, description, reason) is truncated and has its backticks
and `@` stripped, so user text can never ping @everyone/roles. Subrequests per
event are <= 3, so a full 10-event request stays inside the free-plan cap of
50. A 429 from Discord is retried once, honouring `retry_after` (wait capped
at 5 s).

Plain JavaScript ES modules, **zero runtime dependencies**. Tests run with
bare Node (no install needed):

```
cd worker
node --test        # offline tests: fake KV, injected fetch, Ed25519 keypair
```
