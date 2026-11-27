# The Cloudflare Worker (`worker/`)

Plain JS ES modules with **zero runtime dependencies** (`wrangler` is a
devDependency run by the owner). Everything service-facing is injected:
`handle(request, env, fetch)`, so tests supply fakes. The wire-level upload
contract is in `worker/README.md` and `mod-contract/upload.md`;
this doc covers behavior and invariants.

Source: `src/index.js` (routing, `/discord`, `/upload`, `/uploads/results`,
`/whoami`), `src/auth.js` (D1 tokens and login codes), `src/quota.js` (the D1
daily upload quota), `src/ephemeral.js` (self-deleting Discord replies),
`src/uploads.js` (the D1 upload status behind the status button).

## `POST /discord`

The Interactions endpoint (slash commands over HTTPS; there is no gateway or
WebSocket bot).

- The Ed25519 signature check is required; without it the answer is 401.
  PING gets PONG.
- Every reply is the interaction response itself: `200` with
  `Content-Type: application/json` and a body of `{type: 1}` (PONG) or
  `{type: 4, data: {content, flags: 64}}`. The request path makes no outbound
  call and uses no bot token.
- The invoking user id is `member.user.id`; current member objects have no
  top-level `id`. DMs use `user`.
- **No GitHub calls on this path.** Discord requires the reply within 3 s.
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
- `mods_status` ("Check upload status") replies ephemerally with the
  clicker's last 3 uploads, newest first (see "Upload status"). Replies set
  `allowed_mentions: {parse: []}`.
- `mods_signout` runs `revokeAllTokens`: deletes every token of the clicker
  and invalidates unused codes.
- Any other custom id answers 400.

A type-7 response to a component interaction would edit the original
message, so replies use type 4 with flags 64.

## Upload status (D1 `uploads`, `src/uploads.js`)

`/discord` makes no GitHub call, so the status button reads D1. One row per
upload, primary key `(discord_id, upload_key)`:

| Column | Meaning |
|---|---|
| `upload_key` | The upload id of a set, or `<ts>__<safe-name>.zip` for a zip package: the inbox asset name without the uploader stamp, so `build.py` (`parse_inbox_name`) derives the same key from the inbox |
| `uploaded_at` | ISO time the Worker queued it |
| `label` | The zip file name, or `mod upload` for a set |
| `status` | `waiting`, `published` or `rejected` |
| `title`, `version`, `reason` | Known once the runner reports the outcome |

- `/upload` inserts a `waiting` row when it answers `202 queued` (a zip
  package or a set's manifest; parts insert nothing). A D1 failure never
  fails the upload.
- The runner reports outcomes to `POST /uploads/results` (below), which
  upserts them. Only the newest 20 rows of each user are kept (older ones are
  deleted on every insert).
- The status reply lists up to 3 rows: `<t:UNIX:f> (<t:UNIX:R>)` (Discord
  renders these in the viewer's own time zone), the mod title and version (or
  the label), and the status: waiting to be processed, published (with the
  site link), or rejected with the reason. No rows: "You haven't uploaded
  anything yet". Titles, labels and reasons are user-controlled: `@`, `<`,
  `>` and backticks are removed and markdown characters escaped.

## `POST /uploads/results`

Called by the `announce` step of `process-inbox.yml`, not by browsers (no
CORS). `Authorization: Bearer <UPLOAD_RESULTS_SECRET>` is compared in constant
time: `503` when the secret is unset, `401` when wrong. The body is a JSON
list of at most 20 reports, at most 64 KiB (`400` / `413` otherwise):

```json
[{ "key": "<upload_key>", "discord_id": "123", "status": "published|rejected",
   "title": "…", "version": "…", "reason": "…" }]
```

Reports with a bad key, id or status are skipped. The answer is
`200 {"stored": n, "skipped": m}`. A report for an unknown key inserts a row
with the current time. The endpoint makes no GitHub call.

## Self-deleting replies

Every ephemeral reply is recorded in the D1 table `ephemeral_deletes`
(`src/ephemeral.js`) with the interaction's `application_id` and `token`,
written through `ctx.waitUntil`. The interaction token authorizes
`DELETE https://discord.com/api/v10/webhooks/{application_id}/{token}/messages/@original`
without a bot token, for 15 minutes.

- A cron trigger (`* * * * *`, the `scheduled` handler) deletes replies 5
  minutes after they were sent. A `404` counts as already deleted. A failed
  delete is retried on the next run; rows older than 14 minutes are dropped
  because their token has expired.
- The login-link reply is deleted as soon as `POST /auth/redeem` succeeds for
  its code. The `/token` reply is deleted the first time that manual token
  authenticates a `/whoami` or `/upload` request. Both lookups go through the
  hash stored with the reply (`login_hash`, `token_hash`), never the secret.
- Replies to interactions without an `application_id` and `token` are not
  recorded.

## `POST /upload`

- `Bearer` token required, else 401. `Content-Length` required, else 411.
  Over 100 MB per upload answers 413 **before any GitHub call**.
- The per-user daily **byte** quota (default 2 GiB, UTC day) lives in the D1
  table `upload_quota` (`src/quota.js`): one upsert checks and charges
  atomically, and an upload that does not fit answers 429 before any GitHub
  call. The charge is refunded when the GitHub upload fails or the `inbox`
  release is missing (503).
- The `inbox` release id is looked up from GitHub on first use and then held
  in a module-level variable (isolate memory).
- Two shapes:
  - zip mode: `X-Filename` must end in `.zip`;
  - set mode: the same `X-Upload-Id` on every upload; the files (`.pak`,
    `.ucas`, `.utoc`, `.sig` or one `.zip`, part-split when large) first, then
    `manifest.json` (`X-File-Idx: -1`) last. The manifest carries the optional
    `metadata` object.
- Both **stream `request.body` straight through** to `uploads.github.com`:
  no buffering, no storage on the Worker.
- The Worker dispatches `process-inbox.yml` (`ref: main`) only after a zip
  upload or a set's manifest, and answers `202 {"status":"queued"}`. A set's
  part answers `202 {"status":"stored"}` without a dispatch.
- A GitHub failure answers 502 without dispatching; a missing `inbox` release
  answers 503.
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

- `POST /auth/redeem`: the atomic burn. `200 {token, discordId, username,
  expiresAt}` with an `ms_…` web token whose `expiresAt` is 90 days; 404
  unknown code, 410 expired or used. The code lives in the page's URL
  fragment, so only the page's own script redeems it, as soon as the link
  opens the flow.
- `POST /auth/logout`: 204. Deletes the token only when it is a `web` one.


## Discord forum channel

The runner (not the Worker) creates the mod threads. The forum is locked so
only the bot creates posts: an `@everyone` deny of `SEND_MESSAGES` ("Create
Posts" in a forum channel) while allowing `SEND_MESSAGES_IN_THREADS`. The bot
keeps an explicit allow overwrite: View, `SEND_MESSAGES`,
`SEND_MESSAGES_IN_THREADS`, `EMBED_LINKS`.

## Secrets and tokens

`UPLOAD_RESULTS_SECRET` is a long random string stored as a Worker secret and
as the GitHub Actions secret of the same name.

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
login codes, buttons, the upload path and quota, command registration, and the shared contract fixtures against `site/` libraries.
Live behavior (deploy, real Discord, real GitHub, the free-plan CPU limit on
streaming) is verified by the owner.
