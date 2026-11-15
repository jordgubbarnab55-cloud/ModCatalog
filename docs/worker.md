# The Cloudflare Worker (`worker/`)

Plain JS ES modules with **zero runtime dependencies** (`wrangler` is a
devDependency run by the owner). Everything service-facing is injected:
`handle(request, env, fetch)`, so tests supply fakes. The wire-level upload
and events contract is in `worker/README.md` and `mod-contract/upload.md`;
this doc covers behavior and invariants.

Source: `src/index.js` (routing, `/discord`, `/upload`, `/whoami`),
`src/auth.js` (D1 tokens and login codes), `src/mirror.js`
(`/catalog/events`), `src/discord.js` (Discord REST helpers).

## `POST /discord`

The Interactions endpoint (slash commands over HTTPS; there is no gateway or
WebSocket bot).

- The Ed25519 signature check is required; without it the answer is 401.
  PING gets PONG.
- Response flow: **202 ACK (no body)**, then
  `POST /interactions/{id}/{token}/callback` with
  `{type: 4, data: {content, flags: 64}}` (PING ACKs with a PONG callback).
  A flat inline 200 body is rejected by Discord.
- The invoking user id is `member.user.id`; current member objects have no
  top-level `id`. DMs use `user`.
- **No GitHub calls on this path.** The 3 s budget covers the 202 ACK only.
- `/token` mints a `manual` token: `mm_` + base64url(32 random bytes). Only
  `sha256(token)` is stored, as a D1 `tokens` row (`discordId`, `username`,
  `kind`, `createdAt`, `expiresAt`). `username` is the account name
  (`member.user.username`, or `user.username` in a DM), not `global_name` and
  not the nickname. One manual token per user: minting again replaces the
  old one, which is also the revoke path. The command is bare and
  parameter-free. The reply is ephemeral (flags 64).

## Discord buttons

One persistent bot message in the guild's #mods text channel, posted or
edited by `worker/scripts/post-mods-message.mjs`. Type-3 dispatch is on
`custom_id`:

- `mods_upload` mints a login code and replies ephemerally with an "Open the
  uploader" link button (`SITE_URL` + `#login=<code>`: a fragment, never a
  query). The 6th click in 60 s is rate-limited.
- `mods_signout` runs `revokeAllTokens`: deletes every token of the clicker
  and invalidates unused codes.
- Any other custom id answers 400.

A type-7 callback on a component interaction would edit the original message,
so replies use type 4 with flags 64.

## `POST /upload`

- `Bearer` token required, else 401. `Content-Length` required, else 411.
  Over 100 MB per part answers 413 **before any GitHub call**. A per-user daily
  **byte** quota (default 2 GiB) answers 429. A missing `inbox` release
  answers 503.
- Two shapes:
  - zip mode: `X-Filename` must end in `.zip`;
  - set mode: the same `X-Upload-Id` on every upload, plus `manifest.json`
    (`X-File-Idx: -1`) and the optional `metadata.json` (`X-File-Idx: -2`,
    single part); file names `.pak/.ucas/.utoc/.sig` or one `.zip`.
- Both **stream `request.body` straight through** to `uploads.github.com`:
  no buffering, no storage on the Worker. Then it dispatches
  `process-inbox.yml` (`ref: main`) and answers `202 {"status":"queued"}`.
- A GitHub failure answers 502 without dispatching.
- Every inbox asset name is stamped `<discordId>-<hex username>`
  (`docs/inbox-pipeline.md`).
- GitHub's API rejects requests without a `User-Agent`; the Worker sets one.
- CORS: `Access-Control-Allow-Origin` = `ALLOWED_ORIGIN` only. Allowed
  headers: `Authorization, Content-Type, X-Filename, X-Upload-Id, X-File-Idx,
  X-Part-Idx, X-Part-Count`.

## `GET /whoami`

Bearer token gives `200 {discordId, username}`, else 401. CORS as for
`/upload`, with `GET` and `Authorization` in the preflight.

## Auth (D1, `src/auth.js`)

Binding `DB`, database `modcatalog-forum`. One user can hold many tokens:

| Kind | Source | Lifetime |
|---|---|---|
| `manual` | `/token`; one per user, replaced on re-mint | never expires |
| `web` | a redeemed login code; `ms_…` | 90 days |

Login codes (`lc_…`):

- 5-minute TTL, single-use, burned atomically.
- Minting one invalidates the user's older unused codes.
- Rate limit 5 per 60 s.
- Codes are never logged.

Endpoints (same CORS pattern as `/whoami`, with `Content-Type, Authorization`
in the preflight; non-JSON or over-1 KB bodies are 400):

- `POST /auth/peek`: read-only. `200 {discordId, username, expiresAt}`, 404
  unknown, 410 expired or used. Its `expiresAt` is the code's 5-minute expiry.
- `POST /auth/redeem`: the atomic burn. `200 {token, …}` with an `ms_…` web
  token whose `expiresAt` is 90 days.
- `POST /auth/logout`: 204. Deletes the token only when it is a `web` one.

KV (`TOKENS`) holds only the upload quota and the inbox release-id cache.

## `POST /catalog/events` (`src/mirror.js`)

The runner's signed outcome events (the `notify` step).

- `X-Catalog-Signature` = hex HMAC-SHA256(`CATALOG_CALLBACK_SECRET`,
  rawBody). A fresh `ts` is in the signed payload; `|now - ts| > 300 s` is
  401. At most 10 events (`{ts, events: […]}`); a bad shape or an over-size
  body is 400.
- `published` mirrors into one forum thread per mod (D1 `mod_threads` keyed on
  the lowercased identifier):
  - first sight creates a thread: name = title; first message
    `<@uploader> published **title** vVERSION` + description + site link;
    cover embed with a `mod-id:` footer; catalog tags through the var
    `FORUM_TAG_IDS` (catalog tag to forum tag id, unknowns ignored, max 5);
  - an update posts a follow-up message in the existing thread;
  - a thread deleted on Discord (404/403) is re-created and the mapping
    replaced.
- `rejected` posts a notice in `NOTICES_CHANNEL_ID`; blank means a log line
  only. No DMs.
- Mirrored event ids go to `seen_events`; redeliveries are no-ops. Rows are
  swept at 30 days.
- Every payload sets `allowed_mentions` explicitly, and user text is truncated
  with `@` and backticks stripped, so nothing can ping @everyone or roles.
- One failing event is reported `ok: false` (unrecorded, retried by the
  runner) without aborting the rest. Subrequests per event are at most 3.
  429s are retried once (wait capped at 5 s).
- The forum is locked so only the bot creates posts: an `@everyone` deny of
  `SEND_MESSAGES` ("Create Posts" in a forum channel) while allowing
  `SEND_MESSAGES_IN_THREADS`. The bot keeps an explicit allow overwrite: View,
  `SEND_MESSAGES`, `SEND_MESSAGES_IN_THREADS`, `EMBED_LINKS`.

## Secrets and tokens

The fine-grained `GITHUB_TOKEN` expires after at most one year; an expired
token makes uploads answer 502. Set a calendar reminder at creation.

## Owner tools

`scripts/register-commands.mjs` registers the slash commands, reading
`DISCORD_APP_ID` and `DISCORD_BOT_TOKEN` from the environment at run time and
storing nothing. `scripts/smoke-test.sh` runs an upload and polls the catalog.
`scripts/post-mods-message.mjs` posts or edits the #mods message. Deployment
steps are in `SETUP.md`.

## Tests

`cd worker && node --test`. All offline: signature verification, auth and
login codes, buttons, the upload path, the events mirror, command
registration, and the shared contract fixtures against `site/` libraries.
Live behavior (deploy, real Discord, real GitHub, the free-plan CPU limit on
streaming) is verified by the owner.
