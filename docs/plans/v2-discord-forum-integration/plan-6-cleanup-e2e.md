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

# PLAN 6 — Delete the old forum-ingestion system, final end-to-end check

## Goal
Remove every piece of the old "user posts a zip in the forum, bot ingests it" system. No compatibility code.
Then run a full end-to-end regression of the new system on the live dev deployment.

Depends on: Plans 1, 2, 3, 4 and 5 merged and deployed (they add the replacement; this plan assumes
`env.DB`, the `mods_*` component dispatch in index.js, the `/auth/*` and `/catalog/events` routes, the
`notify` step in process-inbox.yml). If any is missing, stop and report.

## Read first
- worker/src/forum.js, worker/src/index.js (imports from forum.js, `scheduled`, handleForumInteraction,
  "/forum/status" route), worker/wrangler.toml, worker/test/forum.test.js, worker/test/worker.test.js
- build.py section "ingest-forum" (ingest_forum, parse_forum_metadata, their helpers, the argparse subparser
  and the dispatch in main), tests/test_ingest.py, .github/workflows/ingest-forum.yml
- `grep -ril forum .` (excluding .agents, node_modules, .wrangler) to find every reference.

## Steps
1. Delete worker/src/forum.js, worker/test/forum.test.js, .github/workflows/ingest-forum.yml.
   worker/migrations/0001_forum_posts.sql stays (history) but add `worker/migrations/0004_drop_forum.sql`:
   `DROP TABLE IF EXISTS forum_posts;`.
2. index.js: remove the forum import, the `scheduled` export, handleForumInteraction and the `forum_*` branch
   of the component dispatch (unknown custom_ids keep returning 400), and the `/forum/status` route. Keep
   uploaderStamp (check who uses it) and everything from Plans 1/2/5.
3. wrangler.toml: delete the `[triggers]` cron block and the vars FORUM_GUILD_ID, FORUM_TAG_MAP,
   FORUM_CUTOFF_THREAD_ID, CATALOG_URL if nothing else reads them (grep first), and the forum comments. Keep
   FORUM_CHANNEL_ID, FORUM_TAG_IDS, NOTICES_CHANNEL_ID, SITE_URL, ALLOWED_ORIGIN, etc.
4. build.py: delete ingest_forum, parse_forum_metadata, the `ingest-forum` subparser/dispatch and any helper
   used ONLY by them (grep each before deleting; keep shared helpers such as the upload-set naming, and keep
   WebP/Pillow cover conversion ONLY if something else still uses it — otherwise delete it). Delete or trim
   tests/test_ingest.py accordingly (keep tests that cover still-existing code).
5. Docs: remove forum-ingestion sections from AGENTS.md, README.md, worker/README.md, SETUP.md (including the
   MESSAGE_CONTENT intent, FORUM_CALLBACK_SECRET, cron and D1-forum setup steps). Describe the new
   mirror/notice flow where the old text sat. Leave docs/plan-*.md and HANDOFF.md alone.

## Offline verification
- Full worker suite and the full Python suite pass.
- `grep -rni "forum" . --include=*.js --include=*.mjs --include=*.py --include=*.yml --include=*.toml
  --include=*.md` (excluding .agents, node_modules, .wrangler, docs/, HANDOFF.md, pi-session-*) only hits
  FORUM_CHANNEL_ID / FORUM_TAG_IDS / the mirror's own forum-thread code and their docs.
- `grep -rn "scheduled\|FORUM_CALLBACK\|ingest-forum\|forum_posts" .` (same exclusions) is empty apart from
  the 0001/0004 migrations.
- The handler-level tests exercise `/discord`, `/upload`, `/whoami`, `/auth/*`, `/catalog/events`.

## Live deployment and cleanup (you have the credentials — do it)
1. Apply migration 0004 remotely, deploy the Worker (the cron trigger disappears with the deploy; confirm in
   the output or the Cloudflare API), commit, push to `main`.
2. Delete the GitHub secrets `FORUM_CALLBACK_URL` / `FORUM_CALLBACK_SECRET` (keep `CATALOG_CALLBACK_*`).
   Delete leftover KV keys `forum:archived_before` and `forum:catalog` (`wrangler kv key delete ... --remote`
   with the namespace id from wrangler.toml; ignore "not found").
3. The privileged MESSAGE_CONTENT intent can be switched off in the Discord developer portal (a Human check;
   only attempt the API route if you are sure it is safe).

## Final end-to-end regression on the live dev deployment (the point of this plan)
Run the complete flow as far as it can be automated and report each step pass/fail:
1. Seed a login code for the owner id in remote D1 (brief) -> open the Pages site with `#login=<code>` in a
   headless browser if you have one (else do the API calls with curl): wizard shows the owner's username, the
   code is redeemed only after clicking Upload, `localStorage` holds a session token.
2. Using that session token, upload a valid test package titled `ZZ Test Final` (`POST /upload`, zip mode and,
   if feasible, one raw set). Watch `process-inbox`; confirm the notify step ran with 200, the catalog on Pages
   lists the mod, a forum thread was created with a ping to the owner (check via the Discord API), then upload
   a version bump (update) and confirm a message in the same thread, then an invalid package and confirm a
   notice appears.
3. Check the old paths are gone: `POST /forum/status` -> 404; no `scheduled` handler; `ingest-forum.yml`
   gone from the Actions list.
4. Clean up everything the test created (threads, notices, releases `mod-*zztest*`, `inbox` leftovers,
   seeded D1 rows, test web tokens) and dispatch `rebuild.yml`; confirm `catalog.json` is back to the
   pre-test mods. Report anything left.

## Human checks to report
- Click the real Discord button -> link -> wizard -> upload one real file from a desktop browser.
- Switch off the MESSAGE_CONTENT intent in the Discord developer portal if you did not.
