# ModCatalog Worker

Cloudflare Worker (free plan) that does two things:

1. **Discord token commands** — `POST /discord` (Interactions endpoint,
   slash commands over HTTPS; no gateway/WebSocket bot). `/token` mints a
   bearer token for the user (shown once, ephemerally); `/token revoke`
   kills it. Only the SHA-256 of the token is stored (in Workers KV).
2. **Upload API** — `POST /upload` takes a bearer token + raw zip body and
   **streams it straight through** to the `inbox` release on GitHub
   (no buffering, no storage — the Worker holds no file bytes), then
   dispatches the `process-inbox` workflow as a wake-up.

Plain JavaScript ES modules, **zero runtime dependencies**. Tests run with
bare Node (no install needed):

```
cd worker
node --test        # 18 offline tests: fake KV, injected fetch, Ed25519 keypair
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

## Upload API contract (for the ModManager app)

```
POST <worker-url>/upload
Authorization: Bearer <token from /token>
X-Filename: <name>.zip          # required, must end in .zip
Content-Type: application/zip    # (any; the value is not validated)
<body: the raw zip bytes>
```

| Status | Meaning |
|--------|---------|
| `202`  | Queued. Body was streamed to the `inbox` release and the processing workflow was woken. The mod appears in `catalog.json` within a couple of minutes. |
| `401`  | Missing / unknown / revoked token. |
| `411`  | `Content-Length` header missing (required). |
| `413`  | Upload over 100 MB (Cloudflare free-plan request-body limit). |
| `429`  | Daily per-user quota exceeded (default 10/day, UTC). |
| `502`  | GitHub failed (token wrong/expired, or upload/dispatch error). Nothing was stored; do not retry blindly — check the token. |
| `503`  | The `inbox` release does not exist yet; run the Seed legacy mods (or Process inbox) workflow once. |

Notes:

- The request body is **streamed, not buffered**: do not wait for a full
  response before uploading; a `202` means GitHub accepted the bytes.
- The response and CORS headers are safe for both the native app (no
  `Origin` sent) and a web page: `Access-Control-Allow-Origin` is the
  `ALLOWED_ORIGIN` var only; allowed headers are
  `Authorization, Content-Type, X-Filename`.
- Asset names in the inbox are `<discordId>__<unixts>__<safe-filename>.zip`;
  the workflow reads the real GUID out of the package and re-homes it.

### Minimum GitHub token permissions (for `GITHUB_TOKEN`)

- **Fine-grained**, resource owner: your account, repository access:
  **only this repo**.
- Repository permissions: **Contents: Read and write**,
  **Actions: Read and write** (metadata read is automatic).
- Fine-grained tokens **expire** (max 1 year). When this token expires,
  uploads start failing with `502` — set a calendar reminder at creation.

## Test status

`node --test` (18 tests) is fully green offline: Discord signature
verification (valid/invalid/missing/wrong key), PING/PONG, token minting /
replacement / revocation (only hashes stored), and the upload path
(401/411/413/400/429/503, happy path with the **same stream object**
forwarded to GitHub, 502-without-dispatch on GitHub failure, CORS
preflight). Live behavior (deploy, real Discord, real GitHub, the free-plan
CPU limit on streaming) is the owner's to verify — see SETUP.md.
