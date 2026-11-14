# ModCatalog Worker

Cloudflare Worker (free plan) that does two things:

1. **Discord token commands** — `POST /discord` (Interactions endpoint,
   slash commands over HTTPS; no gateway/WebSocket bot). `/token` is
   registered **per guild** (guild commands appear in Discord
   immediately) and mints a **`manual`** token for the user (shown once,
   ephemerally). One manual token per user: minting again replaces the
   previous one — that is also the revoke path (the legacy `token revoke`
   subcommand is gone; the command is parameter-free, see step 8). The
   response uses Discord's canonical flow: an immediate **202 ACK (no
   body)** to the interaction, then a `POST /interactions/{id}/{token}/callback`
   with `{type: 4, data: {content, flags}}` (the 3 s budget covers the
   ACK only; the callback token is valid 15 min). Only the SHA-256 of
   the token is stored (in D1, binding `DB`, table `tokens` — see the
   *Auth* section below), next to the account's Discord id and
   **`username`** (the account name — not the display name or the server
   nickname — read from the interaction's `member.user`, or `user` in a DM).
   The catalog publishes mods under that username (verified authors, below).
2. **Upload API** — `POST /upload` takes a bearer token + raw zip body and
   **streams it straight through** to the `inbox` release on GitHub
   (no buffering, no storage — the Worker holds no file bytes), then
   dispatches the `process-inbox` workflow as a wake-up.
3. **`GET /whoami`** — bearer token → `200 {"discordId", "username"}`; the web
   page uses it to validate a token and to show the author name the upload
   will carry. `401 {"error"}` for a missing / unknown / revoked / expired
   token (rejected the same way on `/upload`).

## The #mods buttons (the upload flow's entry point)

A single **persistent bot message** in the guild's #mods text channel carries
the entry point to the web uploader. Two buttons, one action row, handled by
`POST /discord` type-3 interactions (custom_id dispatch in `src/index.js`):

* **`mods_upload`** — "Upload or update a mod": mints a one-time **login
  code** (`mintLoginCode`; the 5-per-60-s limit applies — a limited click
  replies ephemerally with "You're clicking too fast, try again in a
  minute.") and replies (ephemeral, `flags: 64`, the canonical 202-ACK +
  callback flow) with an **"Open the uploader" link button** (style 5) to
  `SITE_URL + "#login=<code>"` — a URL fragment, never a query string. The
  code is never logged. The site peeks it on page load (never burning it)
  and redeems it for a 90-day `web` token only when the user clicks the
  first "Upload a new mod" / "Update a mod". A click whose
  interaction carries no usable username gets an ephemeral error instead.
* **`mods_signout`** — "Sign out everywhere" (danger, style 2):
  `revokeAllTokens` — deletes every token of the clicker (manual and web)
  and invalidates their unused codes; ephemeral confirmation.

Any other custom id 400s.

All button replies are **type-4 + `flags: 64`** (ephemeral *replies*). A
type-7 callback on a message-component interaction is applied to the
**original message** — it edits the public #mods post in place — so it is
deliberately never used here.

`SITE_URL` is a `wrangler.toml` var (the Pages site, ends with `/`);
`loginLinkUrl` normalizes a missing trailing slash.

**The message itself** is posted/edited by the owner script (zero-dep; reads
`DISCORD_BOT_TOKEN` and `MODS_CHANNEL_ID` from the environment at run time
and stores nothing):

```
DISCORD_BOT_TOKEN=... MODS_CHANNEL_ID=... node scripts/post-mods-message.mjs [--edit <messageId>] [--dry-run]
```

No argument posts a new message; `--edit <messageId>` PATCHes the existing
one (how to refresh it after a copy or button change); `--dry-run` prints
the exact request without sending it. **Live message: id `1571116888073703498`
in channel `1571116545638142025` (guild `1565286417968398356`)** — re-edit it with
`--edit 1571116888073703498`.

## Auth: D1 tokens and login codes

Tokens live in **D1** (binding `DB`, database `modcatalog-forum`,
migration `0002_auth.sql`; the logic is `src/auth.js`) instead of KV, so
one user can hold many tokens:

* kind `manual` — minted by `/token` (one per user; a re-mint replaces
  the previous one, which is the revoke path; **never expires**).
* kind `web` — minted by redeeming a one-time **login code** (many per
  user; **90-day expiry**).

Only the sha256 of a secret string is ever stored. Secret shapes: manual
`mm_…`, web `ms_…`, login code `lc_…` (prefix + base64url of 32 random
bytes). KV (`TOKENS`) keeps only the upload quota (`quota:<id>`) and the
inbox release-id cache.

Login codes (table `login_codes`) are **5-minute TTL, single-use**:
minting one invalidates the user's older unused codes, a user can mint
at most 5 per 60 s, and rows older than 24 h are swept
opportunistically. The burn is atomic — `UPDATE login_codes SET
used_at = now WHERE hash = ? AND used_at IS NULL AND expires_at > now`,
succeeding only when exactly one row changed — then a 90-day `web`
token is inserted.

Endpoints (same CORS pattern as `/whoami`: `Access-Control-Allow-Origin`
= `ALLOWED_ORIGIN`, `Content-Type, Authorization` in the preflight;
non-JSON or >1 KB bodies are 400; codes are never logged):

* `POST /auth/peek` `{"code"}` — a read-only check (page load / link
  prefetch must never burn the code): `200 {"discordId", "username",
  "expiresAt"}` | `404 {"error", reason: "unknown"}` | `410 {"error",
  reason: "expired" | "used"}`.
* `POST /auth/redeem` `{"code"}` — the atomic single-use burn: `200
  {"token", "discordId", "username", "expiresAt"}` (the `ms_…` web
  token) | the same errors.
* `POST /auth/logout` — bearer token → `204`; deletes the token only when
  it is a `web` one (a `manual` one is left alone; an unknown token is a
  no-op).

`/upload` and `/whoami` authenticate through the same store.

Plain JavaScript ES modules, **zero runtime dependencies**. Tests run with
bare Node (no install needed):

```
cd worker
node --test        # offline tests: fake KV, injected fetch, Ed25519 keypair
```

## Deploy (owner, brief)

1. `npx wrangler login`
2. `npx wrangler kv namespace create TOKENS` → paste the id into `wrangler.toml`
3. `npx wrangler secret put DISCORD_PUBLIC_KEY` (Discord app public key)
4. `npx wrangler secret put GITHUB_TOKEN` (fine-grained token, see below)
5. Fill `GITHUB_OWNER`, `GITHUB_REPO`, `ALLOWED_ORIGIN` in `wrangler.toml`
6. `npx wrangler deploy`
7. Discord portal → *General Information* → Interactions Endpoint URL =
   `<worker-url>/discord` (the save runs a signed test request)
8. `DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs`
   The commands are **guild-scoped**: the script bulk-registers `token` in
   every guild the bot is a member of (or `DISCORD_GUILD_IDS=
   <id1>,<id2>` for an explicit list), and they appear **immediately** —
   no waiting. A new server later? Invite the bot, re-run the script
   (a server the bot was removed from keeps a harmless registration that
   doesn't resolve there; re-invite + re-run). To retire a leftover global
   `token` command during the first cutover, add `--retire-global`
   (it deletes the global command only after every target guild
   registered; 404 is fine). `--dry-run` prints the exact requests
   without sending them. The command itself is parameter-free by
   design: the original `token` + `revoke` subcommand never appeared in
   this app's client menus (subcommands render as top-level entries,
   and those did not render at all — desktop and mobile), so `/token`
   is directly callable and re-minting is the revoke path.
   (Debugging note: interaction `member` objects in the current Discord
   API carry no top-level `id` — the invoking user's id is nested at
   `member.user.id`; the handler checks `member.id`, `member.user.id`
   and the DM `user.id` in that order. Also: a flat inline 200 response
   body is rejected by Discord ("didn't respond in time" despite a fast
   200) — the reply must go through the callback endpoint after a 202
   ACK.)
9. `DISCORD_BOT_TOKEN=... MODS_CHANNEL_ID=... node
   scripts/post-mods-message.mjs` — post the persistent #mods button
   message (see *The #mods buttons* above).

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
| `503`  | The `inbox` release does not exist yet; run the Seed legacy mods (or Process inbox) workflow once. |

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

### Minimum GitHub token permissions (for `GITHUB_TOKEN`)

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


Required bot permissions: **View Channel, Create Posts, Send Messages in
Posts, Embed Links** in the forum channel (and in the notices channel:
Send Messages + Embed Links). The forum should be locked so *only the bot*
creates posts: an `@everyone` overwrite that denies `SEND_MESSAGES` (1<<11 —
that is "Create Posts" in a forum channel) while allowing
`SEND_MESSAGES_IN_THREADS` (1<<38) + View/Read, and an explicit bot-user
overwrite allowing View Channel, `SEND_MESSAGES`, `SEND_MESSAGES_IN_THREADS`
and `EMBED_LINKS` (1<<14). (Changing those overwrites needs
Manage Channels — a human, or the bot if it has it.)

## Test status

`node --test` is fully green offline: Discord signature
verification (valid/invalid/missing/wrong key), PING/PONG, manual-token
minting / replacement (D1, only hashes stored), login-code mint / peek /
redeem (TTL, single-use atomic burn incl. a concurrent-redeem race,
invalidation by a newer code, 5-per-60-s rate limit, 90-day web tokens,
`/auth/*` handler + CORS + bad bodies), the #mods buttons (the `mods_upload`
ephemeral link-button reply + the minted code's validity via peek + the
6th-click rate-limit message, `mods_signout`'s full revocation, the
unknown-custom_id 400s, `loginLinkUrl`), the upload path
(401/411/413/400/429/503, upload sets incl. `.zip` and `metadata.json`, happy path with the **same stream object**
forwarded to GitHub, 502-without-dispatch on GitHub failure, CORS
preflight), and the `/catalog/events` mirror (bad/missing signature, tampered body,
stale/future `ts` -> 401, >10 events / bad shape / over-size body -> 400,
thread create + mapping + seen recording, update-in-thread, deleted-thread
404 re-create, duplicate-delivery no-op, one-failing-event isolation +
redelivery, rejected notices, NOTICES-unset no-call, @everyone
neutralisation, 429 retry-once), and the command-registration script (bulk-PUT payload shape,
per-guild 403 isolation, `--retire-global` ordering, delete-404
tolerance, auto-discovery, dry-run) plus the #mods message script (payload
shape, POST/PATCH, dry-run, error detail). Live behavior (deploy, real Discord, real GitHub, the free-plan
CPU limit on streaming) is the owner's to verify — see SETUP.md.
