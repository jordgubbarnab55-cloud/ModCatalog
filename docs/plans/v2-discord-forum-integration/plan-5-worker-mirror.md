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

# PLAN 5 — Worker: /catalog/events receiver, forum mirror, rejection notices

## Goal
Receive the runner's signed outcome events and (a) create/update a Discord forum thread per mod pinging the
uploader, (b) post rejection notices mentioning the uploader. Nobody but the bot posts in the forum. Deploy,
configure the Discord side, and verify live.

Depends on: Plan 1 (D1 binding `DB`, test helper `worker/test/helpers/fake-d1.js`). It does NOT depend on
Plan 4 being implemented — build against the contract below. (If Plan 4 is deployed you can also run a real
end-to-end upload at the end.)

## Contract (sent by the runner, see Plan 4)
```
POST /catalog/events
Headers: Content-Type: application/json
         X-Catalog-Signature: hex(HMAC-SHA256(CATALOG_CALLBACK_SECRET, rawBody))
Body:    {"ts": <unix seconds>, "events": [Event...]}      (<= 10 events)
Event:   {eventId, status:"published"|"rejected", mode:"new"|"update"|null, uploaderId, uploaderName,
          reason?, title, version, description, author, identifier, tags:string[], gameVersion, fileUrl,
          coverUrl, size, sha256, assetName}   (rejected events may have null for unknown fields)
```

## Read first
- worker/src/index.js (routing in handle(), json() helper; CORS is not needed for this route)
- worker/src/forum.js: how it calls the Discord API with `Authorization: Bot <DISCORD_BOT_TOKEN>`, rate-limit
  handling, and how handleForumStatus verifies an HMAC signature + timestamp — mirror its verification style
  (this file is deleted in a later plan, so do NOT import from it: write a fresh `worker/src/discord.js`)
- worker/migrations/, wrangler.toml, worker/test helpers (fake KV/D1/fetch).

## Design
1. Migration `worker/migrations/0003_mirror.sql`:
   ```sql
   CREATE TABLE mod_threads (mod_key TEXT PRIMARY KEY,      -- lowercase identifier
                             thread_id TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE seen_events (event_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
   ```
   (Opportunistically delete seen_events older than 30 days on each request.)
2. `worker/src/discord.js`: `botFetch(env, fetchImpl, method, path, body)` with the bot header, JSON handling,
   and ONE retry honouring 429 `retry_after` (cap the wait at 5 s). Functions: `createForumThread(env,
   fetchImpl, {name, content, embeds, tagIds})`, `postMessage(env, fetchImpl, channelId, payload)`.
   Thread create = `POST /channels/{FORUM_CHANNEL_ID}/threads` with `{name (<=100 chars), message:{content
   (<=2000), embeds, allowed_mentions:{parse:[], users:[uploaderId]}}, applied_tags:[ids]}`. Every outgoing
   payload sets `allowed_mentions` explicitly so user-supplied text can never ping @everyone/roles;
   user-supplied text (title, description) is truncated and has `@` and backtick-injection neutralised.
3. `worker/src/mirror.js`: `handleCatalogEvents(request, env, fetchImpl)`:
   - 405 unless POST; read the raw body (max 256 KB) once; verify X-Catalog-Signature with constant-time
     comparison; reject |now - ts| > 300 s with 401; 400 on bad JSON, >10 events, bad event shapes.
   - For each event in order (never let one failure abort the others): skip if eventId is in seen_events
     (idempotent retries); else
     - published & no mod_threads row (new, or an update whose thread does not exist yet): create a forum
       thread. name = title. First message content: "<@uploaderId> published **title** vVERSION" + the
       description (truncated) + a link to SITE_URL. One embed: cover as `image` when coverUrl is set, footer
       text "mod-id: <identifier>" (so the thread is identifiable). applied_tags from the catalog tags through
       `FORUM_TAG_IDS` (JSON object catalog-tag -> forum tag id; unknown tags ignored; max 5). Store
       mod_threads(mod_key, thread_id).
     - published & thread exists: post "<@uploaderId> uploaded **vVERSION**" (+ description, cover embed) in
       that thread. If Discord answers 404/403 for the thread (deleted), create a fresh thread and replace the
       mapping.
     - rejected: if `NOTICES_CHANNEL_ID` is set, post "<@uploaderId> your upload of **title/unknown** was not
       accepted: reason" there; otherwise log one line. No DM logic.
     On Discord success insert the eventId into seen_events. On failure leave it unrecorded and mark that
     event failed in the response so a retry can redo it.
   - Respond 200 `{results:[{eventId, ok:true|false, skipped?:true, error?:string}]}`. Subrequests per event
     are small (<= 3); with <=10 events this stays inside the free-plan limit of 50 subrequests.
4. Route `/catalog/events` in handle(). New secret `CATALOG_CALLBACK_SECRET`; vars `FORUM_TAG_IDS`
   (default `"{}"`) and `NOTICES_CHANNEL_ID` (blank = none); existing `FORUM_CHANNEL_ID`, `SITE_URL` (from
   Plan 2; if absent when you start, add it). The bot secret `DISCORD_BOT_TOKEN` is reused. Do not touch the old
   `FORUM_*` poller vars here.
5. Docs: worker/README.md (new route, vars, required bot permissions), AGENTS.md (Worker section).

## Offline verification
- Tests (fake fetch recording Discord calls, FakeD1): bad/missing signature -> 401; stale ts -> 401; tampered
  body -> 401; new published event -> one thread create with the right name/tags/mention/allowed_mentions,
  mapping stored; update event -> a message in the existing thread, no new thread; deleted-thread 404 -> new
  thread + mapping replaced; duplicate delivery of the same body -> second response is all skipped and Discord
  is called zero extra times; one failing event does not block the next one and is reported ok:false and is
  retried successfully on redelivery; rejected event -> notice with a user-only mention; NOTICES unset -> no
  Discord call; title "@everyone" never produces a mention; 429 with retry_after is retried once; 11 events
  -> 400.
- Whole worker suite passes.

## Live deployment and verification (you have the credentials — do it)
1. Capability probing for Discord. Inspect the forum channel (`GET /channels/1570021563602829374`): note its
   `available_tags` and the current permission overwrites (write the previous overwrites into your report so
   they can be restored). If the forum has tags that correspond to the catalog tag vocabulary
   (`mod-contract/tags.json`), fill `FORUM_TAG_IDS` accordingly; otherwise leave `{}`.
2. Lock the forum so only the bot creates posts: with the bot (needs Manage Roles / Manage Channels; if it
   lacks them, report it as a Human check instead), deny `@everyone` the "Create Posts" permission on the
   forum channel while keeping "Send Messages in Posts" allowed. In forum channels "Create Posts" is the
   SEND_MESSAGES bit (1<<11) and "Send Messages in Posts" is SEND_MESSAGES_IN_THREADS (1<<38) — verify
   against the Discord docs before applying — and make sure the bot itself keeps Create Posts, Send Messages in
   Posts and Embed Links (an explicit allow overwrite for the bot user).
3. Notices channel: reuse an existing text channel or create `catalog-notices` with the bot; set
   `NOTICES_CHANNEL_ID`.
4. Apply migration 0003 remotely, `wrangler secret put CATALOG_CALLBACK_SECRET` (value from
   `secrets/forum_callback_secret.txt`, on stdin), deploy, commit, push to `main`.
5. Drive the live route with curl using signed bodies (HMAC with openssl; fresh `ts`):
   - bad signature -> 401; a `published` event for identifier `zztest.plan5` -> 200 ok:true and a new forum
     thread appears (verify via Discord API: name, first message mentions the owner id, embed footer has
     `mod-id`); the SAME body again -> skipped; an `update` event for the same identifier -> a new message in
     the same thread; a `rejected` event -> a notice in the notices channel (or a log line only if unset);
     a title containing `@everyone` -> no mass mention in the Discord message (check `mentions` /
     `mention_everyone` is false).
   - If Plan 4 is deployed, also do one real upload (see the brief) and confirm a thread is created and the
     uploader is pinged after the run.
6. Clean up: delete the test threads/messages you created (`DELETE /channels/<thread_id>`), delete test rows
   from `mod_threads`/`seen_events` (`mod_key LIKE 'zztest%'`), and any test uploads as in the brief.

## Out of scope
The runner (Plan 4), deleting the forum poller (Plan 6).

## Human checks to report
Look at the forum in Discord: members can open a post and reply but cannot create posts; the bot's post looks
right (embed, mention, tags).
