# SHARED BRIEF — ModCatalog (read first; applies to every plan)

You are one of several independent agent sessions implementing one system. You share NO context with the
other sessions except what is written in your plan and in the repo. Do only your plan's scope.

## Repo and architecture

Repo root = the ModCatalog project (git repo, `main` branch). It is vibe-coded: ignore HANDOFF.md,
pi-session-*.md, card-designs*.html, `.agents/`, `docs/plan-*.md` and other large hand-off files unless your
plan says otherwise. Read AGENTS.md and worker/README.md for the architecture. In short: free-tier stack =
GitHub Actions + Releases + Pages, and ONE Cloudflare Worker (`worker/`, plain JS ES modules, ZERO runtime
dependencies, tests run with bare `node --test` from `worker/`, Node 20+). Python side: `build.py` +
`trailer.py` are stdlib-only; tests in `tests/` (unittest). The static site (`site/`) has no build step, no
framework, no CDN.

## Ground rules for ALL plans

- Nothing in this system is in active use yet. DO NOT write legacy handling, migration handling,
  compatibility shims, feature flags or fallbacks for old data/behaviour. Old code may be deleted even if it
  breaks other things, as long as your plan's own verification passes. If you remove something another plan
  will replace, just remove it. Breaking the live dev deployment temporarily is acceptable; leaving it
  broken at the end of your session is not (fix forward, or revert your commit and report).
- `mod-contract/` is a vendored copy of a shared contract: DO NOT edit it.
- `site/catalog.json` is generated: never edit it by hand (the pipeline commits it). Never commit zips or
  cover images to git.
- Keep the zero-dependency rule (Worker, site, build.py). Unit tests must run offline.
- Match existing style. Many files use CRLF line endings: preserve each file's existing endings (check
  `.gitattributes`; do not mass-convert).
- Everything service-facing in the Worker is injected: `handle(request, env, fetchImpl)`. Keep it testable.
- Update docs your change makes stale (AGENTS.md, README.md, worker/README.md, SETUP.md) in the same plan;
  keep edits short and factual.
- The plan author only skimmed the code. VERIFY every file/function/line claim in your plan before relying
  on it, and adapt if reality differs (say so in your report).
- Final report: what changed (files), how you verified (commands + results, live and offline), deviations
  from the plan, leftover test artifacts, and a short "Human checks" list (things only a person can do, e.g.
  clicking a Discord button).

## Product summary (the target system)

Users do NOT post mods in a Discord forum any more. Flow:

1. A bot message in a normal text channel (#mods) has a button "Upload or update a mod".
2. Clicking it makes the Worker mint a ONE-TIME login code and reply ephemerally with a link button to
   `<SITE_URL>#login=<code>` (a URL fragment, never a query string).
3. The site opens the existing upload wizard. When the user clicks "Upload a new mod" / "Update a mod"
   (the first choice step) the code is redeemed (burned) for a long-lived web session token kept in
   localStorage. Page load / link prefetch must never burn it (a non-burning "peek" is used for display).
4. Uploads go through the existing `POST /upload` -> `inbox` release -> `process-inbox` workflow.
5. After the workflow publishes (or rejects) a package it reports to the Worker, which mirrors the mod into
   a Discord forum (a discussion place; only the bot may create posts) and pings the uploader.

A token means "this is Discord user X". Later, the same token will also authorize downloads of private/paid
mods (served by something else; NOT part of these plans) — so keep token auth in one reusable module.
The `/token` slash command remains: it mints a "manual" token the user pastes into the site's token field.

## Fixed decisions

- Token storage moves from KV to D1 (table `tokens`), so one user can hold many tokens.
  kind `manual` = from `/token` (one per user; minting replaces the previous manual one; never expires);
  kind `web` = from a redeemed login code (many allowed; 90-day expiry).
- Login codes: 5-minute TTL, single-use, only the sha256 is stored, burned atomically in D1.
- Secret strings: manual token `mm_<base64url of 32 random bytes>`, web token `ms_<...>`, login code
  `lc_<...>`. Only hashes are stored.
- KV (binding `TOKENS`) stays only for upload quota (`quota:<id>`) and the inbox release-id cache.
- The Worker URL the site uses is derived from `site/config.json` `uploadUrl` (which ends in `/upload`).

## Credentials and the live dev environment (you have full access)

The folder `secrets/` in the repo root (gitignored; confirm with `git check-ignore secrets/`) holds
throwaway-account credentials for the dev deployment. You are explicitly authorized to use them for
anything this plan needs: commit and push to `main`, deploy the Worker, apply remote D1 migrations, set
Worker secrets and vars, set GitHub Actions secrets/variables, dispatch and watch workflows, create/edit
Discord messages, channels and forum threads with the bot, and create and delete test data. Breaking the dev
deployment temporarily is not a problem. Stay inside this project's own resources: this GitHub repo, the
`modcatalog` Worker + its D1/KV in this Cloudflare account, and the one Discord guild below. Do not touch
anything else.

Files (names are what the owner supplied; the exact scopes are NOT documented, so probe, don't assume):

| file | probably | use for |
|---|---|---|
| `cloudflare_token.txt` | Cloudflare API token | `CLOUDFLARE_API_TOKEN` for wrangler / API |
| `discord_adminuid.txt` | the owner's Discord user id | admin id; the identity of test uploads |
| `discord_appid.txt` | Discord application id | `DISCORD_APP_ID` |
| `discord_pubkey.txt` | Discord app public key (base64) | Worker secret `DISCORD_PUBLIC_KEY` |
| `discord_token.txt` | Discord bot token | `Authorization: Bot <token>`; Worker secret `DISCORD_BOT_TOKEN` |
| `forum_callback_secret.txt` | an old shared HMAC secret | reuse its value as `CATALOG_CALLBACK_SECRET` (Plans 4/5) |
| `github_pat.txt`, `github_pat2.txt`, `github_tokenclassic.txt` | GitHub tokens (fine-grained and/or classic) | `gh` / REST / git push; one of them is the Worker's `GITHUB_TOKEN` |

Secret hygiene (non-negotiable even though the accounts are throwaway):
- NEVER print, echo, log, paste into the report, or commit a secret's value. Read files with trailing
  whitespace/newlines trimmed and pass them through environment variables or stdin, e.g.
  `export CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < secrets/cloudflare_token.txt)"`.
  For `wrangler secret put`, pipe the value on stdin. Disable shell tracing (`set +x`) around secret use.
- Never write secrets into tracked files, `wrangler.toml`, workflow files, docs or test fixtures.
  `worker/.dev.vars` is gitignored and may hold local copies. Before EVERY commit run `git status` and
  `git diff --cached` and look for secret-looking strings; if one was ever committed, stop, say so in the
  report (the owner will rotate it) and do not try to rewrite history.
- If a command's output could contain a secret (e.g. `gh auth status`, `wrangler secret list` is safe,
  `env`), do not paste it into the report.

Known values (verify; they come from the repo files, not from you guessing):
- GitHub: owner `jordgubbarnab55-cloud`, repo `ModCatalog`, default branch `main`.
- Pages site / SITE_URL: `https://jordgubbarnab55-cloud.github.io/ModCatalog/`
- Worker: name `modcatalog`, URL `https://modcatalog.modcatalog-worker.workers.dev` (from
  `site/config.json` `uploadUrl`; confirm with the first deploy's output).
- Cloudflare account id: `b6c16693895ef7ec0ad7c3da30c1ca4a` (from `.wrangler/cache/wrangler-account.json`;
  export it as `CLOUDFLARE_ACCOUNT_ID`). D1 database `modcatalog-forum` (binding currently `FORUM`, renamed
  to `DB` by Plan 1; keep the database itself), KV binding `TOKENS`; ids are in `worker/wrangler.toml`.
- Discord guild id `1565286417968398356`; the old forum channel id `1570021563602829374` (in wrangler.toml).

Capability probing (do this once at the start of any plan that needs live access, record results in your
report WITHOUT secret values):
- Cloudflare: `cd worker && npx wrangler whoami` with the env vars above; `npx wrangler d1 list`.
- Discord: `GET https://discord.com/api/v10/users/@me` and `/applications/@me` with `Authorization: Bot ...`;
  `GET /guilds/<guild>/channels` to see the channels and `GET /channels/<forum>` for forum tags.
- GitHub: for each of the three token files, `GET https://api.github.com/user` and
  `GET /repos/<owner>/<repo>` with `Authorization: Bearer ...` (for classic tokens read the
  `x-oauth-scopes` response header). Pick one token for `gh`/git push/dispatch and one (fine-grained, this
  repo only: Contents + Actions read/write is enough) for the Worker's `GITHUB_TOKEN`. Setting Actions
  secrets needs a token with repo/secrets permission: try `gh secret set NAME --repo <owner>/<repo>` (with
  `GH_TOKEN`) and fall back to another token if it is refused. If git push uses a token, push via an
  authenticated URL passed on the command line (do not store it in `.git/config`).
- Commands in this brief are bash; the owner's machine is Windows, so translate to the shell you actually
  have (Git Bash / PowerShell) if needed.

Worker baseline: the deployed Worker must have the secrets `DISCORD_PUBLIC_KEY`, `GITHUB_TOKEN`,
`DISCORD_BOT_TOKEN` (`npx wrangler secret list` shows names only). Put any that are missing with
`npx wrangler secret put NAME` (value on stdin). Later plans add `CATALOG_CALLBACK_SECRET`.

Deploy workflow for any plan that changes the Worker: offline tests green -> commit -> (apply new remote D1
migrations FIRST: `cd worker && npx wrangler d1 migrations apply modcatalog-forum --remote`) ->
`npx wrangler deploy` -> live verification -> push to `main` (workflows and Pages deploy from `main`, and
the Worker dispatches `process-inbox.yml` with `ref: main`, so anything involving workflows needs the code on
`main`). `git pull --rebase` before pushing; never force-push. Small, clearly named commits.

Driving the live system without a human:
- You cannot click Discord buttons and you do not hold the Discord app's private signing key, so you cannot
  forge interactions against the live Worker. Interaction handling is therefore verified by offline tests
  with locally generated Ed25519 keys; the live check of a real button click goes into "Human checks".
- You CAN seed state straight into the remote D1 database, e.g.
  `npx wrangler d1 execute modcatalog-forum --remote --command "INSERT INTO login_codes ..."` (compute
  `sha256` of the plaintext locally, e.g. `printf %s "$CODE" | sha256sum`). This is how you make a valid login
  code or an upload token for the owner's Discord id (`secrets/discord_adminuid.txt`; get its username with
  Discord `GET /users/<id>` via the bot) and then drive the real HTTP endpoints with curl.
- A real end-to-end upload: seed a token, then `POST /upload` with `Authorization: Bearer <token>`,
  `Content-Length` and `X-Filename: <name>.zip` (zip mode; see worker/README.md and mod-contract/upload.md),
  then `gh run list/watch` the `process-inbox` run and check the result. Build the test package the way
  `tests/test_ingest.py` / `tests/test_build.py` / `make_examples.py` build valid packages (a UE container
  `.utoc`+`.ucas` with a trailer); fixtures live under `mod-contract/fixtures/`.
- Name every test mod with the prefix `ZZ Test` (title) so it is recognizable.
- CLEAN UP what you create (test forum threads, test messages/channels you created, test mod releases
  `mod-*zztest*`, seeded D1 rows, leftover `inbox` assets); after deleting releases dispatch `rebuild.yml`
  so `catalog.json` forgets them. List anything you intentionally left in the report.


---

# PLAN 1 — Worker auth core (tokens in D1, login codes, /auth/* endpoints)

## Goal
Replace the Worker's KV token system with a D1-backed token store that supports many tokens per user, and add
the one-time login-code endpoints the website will use. Deploy it and verify it live. No Discord button and
no website changes here.

Depends on: nothing.

## Read first
- worker/src/index.js (authenticate, handleDiscord, `/token` minting, handleUpload, handleWhoami, CORS pattern)
- worker/wrangler.toml, worker/migrations/0001_forum_posts.sql
- worker/test/worker.test.js and worker/test/forum.test.js (find the Ed25519 signing helper, the fake KV, and
  the FakeD1 that matches prepared statements by SQL string — reuse that approach)
- worker/README.md

## Design
1. D1: the current binding is `FORUM` (database `modcatalog-forum`). Rename the binding to `DB` (same
   database) and change every `env.FORUM` in worker/src and worker/test to `env.DB` (mechanical; the forum
   code is deleted in a later plan). Add migration `worker/migrations/0002_auth.sql`:
   ```sql
   CREATE TABLE tokens (
     hash TEXT PRIMARY KEY,           -- sha256 hex of the token string
     discord_id TEXT NOT NULL,
     username TEXT NOT NULL,
     kind TEXT NOT NULL,              -- 'manual' | 'web'
     created_at TEXT NOT NULL,
     expires_at TEXT                  -- NULL = never
   );
   CREATE INDEX idx_tokens_user ON tokens(discord_id, kind);
   CREATE TABLE login_codes (
     hash TEXT PRIMARY KEY,
     discord_id TEXT NOT NULL,
     username TEXT NOT NULL,
     created_at TEXT NOT NULL,
     expires_at TEXT NOT NULL,
     used_at TEXT                     -- set when burned OR invalidated by a newer code
   );
   CREATE INDEX idx_codes_user ON login_codes(discord_id, created_at);
   ```
2. New module `worker/src/auth.js` exporting (all take `db` = env.DB and an explicit `now` Date for tests):
   - `newSecret(prefix)` -> prefix + base64url(32 random bytes); `sha256Hex(str)` (move/share the helpers that
     currently live in index.js; avoid circular imports — put shared crypto helpers in auth.js or a new
     `worker/src/util.js` and import from there in index.js).
   - `mintManualToken(db, {discordId, username, now})` -> token string; deletes that user's previous
     kind='manual' row, inserts the new one. Returns the plaintext token once.
   - `mintLoginCode(db, {discordId, username, now})` -> `{code}` | `{limited: true}`.
     Marks the user's older unused codes as used (invalidation), refuses when >=5 codes were created for the
     user in the last 60 s, inserts the new code (TTL 300 s), and opportunistically deletes rows older than
     24 h from login_codes.
   - `peekLoginCode(db, code, now)` -> `{ok:true, discordId, username, expiresAt}` | `{ok:false, reason}`
     with reason `'unknown' | 'expired' | 'used'`. Read-only (never changes state).
   - `redeemLoginCode(db, code, now)` -> `{ok:true, token, discordId, username, expiresAt}` | `{ok:false, reason}`.
     MUST be atomic: `UPDATE login_codes SET used_at=?1 WHERE hash=?2 AND used_at IS NULL AND expires_at>?1`
     and succeed only if exactly one row changed (check `meta.changes`); then insert a 'web' token with
     expires_at = now + 90 days. Return the plaintext token once.
   - `authenticateToken(db, token, now)` -> `{discordId, username, kind}` | null (unknown or expired -> null).
   - `deleteWebToken(db, token)` -> deletes only if kind='web' (a 'manual' token is left alone).
   - `revokeAllTokens(db, discordId)` -> deletes every token and invalidates unused codes of that user
     (used by a later plan).
3. index.js:
   - `authenticate(request, env, cors)` uses authenticateToken. Delete STALE_TOKEN_MESSAGE and the KV
     `tok:`/`user:` logic. 401 body keeps `{error: ...}`.
   - `/token` command: mintManualToken, same ephemeral reply text as today. Remove the `token revoke`
     subcommand path entirely (it is not registered anymore).
   - New routes (same CORS pattern as /whoami: `Access-Control-Allow-Origin = env.ALLOWED_ORIGIN`, OPTIONS
     preflight, allowed headers `Content-Type, Authorization`):
     - `POST /auth/peek`   body `{"code": "..."}` -> 200 `{discordId, username, expiresAt}`
       | 404 `{error, reason:'unknown'}` | 410 `{error, reason:'expired'|'used'}`
     - `POST /auth/redeem` body `{"code": "..."}` -> 200 `{token, discordId, username, expiresAt}` | same errors
     - `POST /auth/logout` Bearer token -> 204 (deletes it if kind 'web', no-op for 'manual')
     Reject non-JSON / oversize (>1 KB) bodies with 400. Codes are never logged.
   - `/upload` and `/whoami` keep their contracts; they just authenticate through the new store.
4. wrangler.toml: the binding rename and a comment documenting the migration. No cron or vars here.

## Steps
1. Read the files above. 2. Add the migration + auth.js + wire index.js. 3. Update/replace the existing tests
that seed KV tokens (`tok:`/`user:`) to seed D1 rows; put the FakeD1 into a shared test helper
(`worker/test/helpers/fake-d1.js`) if it is currently private to forum.test.js, supporting the new statements
(including `changes` counts for the atomic burn). 4. Add `worker/test/auth.test.js`. 5. Update
worker/README.md (auth section) and AGENTS.md (Worker section: tokens in D1, kinds, /auth/*).
6. Capability probing (see the brief), then deploy + live verification below.

## Offline verification (all must pass; run the whole worker suite)
- Unit tests: mint/peek/redeem happy path; peek twice leaves the code usable; redeem twice -> second fails
  'used'; expired code (advance `now` 301 s) -> 'expired' for both peek and redeem; a newer code invalidates
  the older one; rate limit at the 6th code within 60 s; two concurrent redeem calls (Promise.all) -> exactly
  one succeeds; a 'web' token expires after 90 days; `/token` replaces the previous manual token but leaves
  web tokens alone; logout deletes a web token and leaves a manual one; revokeAllTokens clears everything.
- Handler-level tests through handle(): /auth/* CORS preflight, 400 on bad bodies, /whoami and /upload still
  behave (401 unknown token, 200 identity, upload streaming path unchanged).
- `grep -rn "tok:\|user:" worker/src` shows no KV token usage left; `grep -rn "env.FORUM" worker` is empty.

## Live deployment and verification (you have the credentials — do it)
1. Ensure the Worker baseline secrets exist (see the brief). 2. `npx wrangler d1 migrations apply
   modcatalog-forum --remote`, then `npx wrangler deploy` from `worker/`. Commit and push to `main`.
3. Seed a login code for the owner's Discord id: compute a random `lc_...` code and its sha256 locally, then
   `wrangler d1 execute modcatalog-forum --remote --command "INSERT INTO login_codes (...)"` with
   expires_at = now+5 min. Then with curl against the live Worker URL:
   - `POST /auth/peek` twice -> 200 both times (state unchanged);
   - `POST /auth/redeem` -> 200 with a `token` (`ms_...`); a second redeem -> 410 reason `used`;
   - `GET /whoami` with that Bearer token -> 200 with the owner's id and username;
   - `OPTIONS /auth/redeem` with `Origin: https://jordgubbarnab55-cloud.github.io` -> CORS headers present;
     with another Origin the allow-origin header is not that origin;
   - `POST /auth/logout` with the token -> 204, then `GET /whoami` -> 401;
   - seed an already-expired code -> peek/redeem give 410 `expired`.
4. Seed a `manual` token row directly into D1 for the owner id (keep its plaintext for later plans' tests
   only inside your own session; do not write it anywhere) and confirm `POST /upload` with a bad token is
   401 and `/whoami` with the good one is 200.
5. Clean up: delete the seeded rows you created (`DELETE FROM tokens/login_codes WHERE ...`).

## Out of scope
Discord button, website, forum removal, GitHub workflows.

## Human checks to report
Running `/token` in Discord still replies with a token (cannot be tested live without a real interaction).
