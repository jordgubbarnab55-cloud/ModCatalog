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

# PLAN 3 — Website: #login=<code> flow in the upload wizard

## Goal
Opening `<site>#login=<code>` starts the existing upload wizard already "signed in" (non-burning peek), and
the code is redeemed for a stored web session at the moment the user clicks "Upload a new mod" or "Update a
mod". Logout support. Better upload-confirmation text. Deploy to Pages and verify against the live Worker.

Depends on: Plan 1's endpoints (deployed live). You do NOT need Plan 2 to build or test this.

## Endpoint contracts (implemented by Plan 1)
- `POST <worker>/auth/peek`   `{"code"}` -> 200 `{discordId, username, expiresAt}` | 404/410 `{error, reason}`
- `POST <worker>/auth/redeem` `{"code"}` -> 200 `{token, discordId, username, expiresAt}` | 404/410 `{error, reason}`
- `POST <worker>/auth/logout` `Authorization: Bearer <token>` -> 204
- reason is `'unknown' | 'expired' | 'used'`. CORS is allowed for the site origin
  (`https://jordgubbarnab55-cloud.github.io`) only.
- `<worker>` is the origin of `site/config.json` `uploadUrl` (which ends in `/upload`).

## Read first
- site/index.html (the `#upload` hash handling near the flow wiring, the Upload button, config.json load)
- site/upload-flow.js (tokenStore, Session.begin/stepCheck/stepToken/stepChoice/choose/stepNext,
  differentToken(), the upload request + success message near the end)
- site/upload-lib.js (checkToken, whoamiUrl and similar pure helpers) and worker/test/upload-lib.test.js
  (how the site's pure modules are tested with node --test)
- site/modal.js for modal helpers.

## Design
1. `upload-lib.js` (pure, tested): `parseLoginHash(hash)` -> code | null (accept only `#login=` +
   `/^lc_[A-Za-z0-9_-]{20,80}$/`); `authUrl(uploadUrl, "peek"|"redeem"|"logout")` derived like whoamiUrl;
   `peekCode(url, code, fetchImpl)` and `redeemCode(url, code, fetchImpl)` returning `{ok:true,...}` |
   `{ok:false, reason:'unknown'|'expired'|'used'|'network', message}`.
2. index.html: next to the existing `#upload` handling, if location.hash is a login hash: take the code,
   immediately `history.replaceState` to strip the hash (never keep the code in the address bar/history), wait
   for configPromise, then `flow.start(uploadBtn, {loginCode: code})`. Add
   `<meta name="referrer" content="no-referrer">`. The plain `#upload` hash and the Upload button behave as
   today (no code).
3. upload-flow.js: `start(opener, opts)` passes `opts.loginCode` to the Session. `Session.begin()`:
   - with a loginCode: `stepLoginPeek` — "Checking your link…" modal, peekCode.
     - ok -> `this.identity = {discordId, username}`; `this.pendingCode = code`; `this.stepChoice()` ("Signed
       in as X" is already shown there). A stored token (if any) is ignored from now on in this session;
       the new link wins.
     - not ok (expired/used/unknown) -> if a stored token exists, silently continue with the normal
       stepCheck path and show a one-line note that the link was no longer valid; otherwise show an
       explanatory modal: "This link has expired or was already used. Click the upload button in Discord
       again." with a Close button and a secondary "Paste a token instead" (-> stepToken).
     - network error -> a retry modal (reuse the stepCheckFailed style).
   - without a loginCode: unchanged (stored token -> stepCheck, else stepToken).
   - `choose(mode)`: if `this.pendingCode` exists, FIRST redeem it (show a short busy state on the clicked
     option), on success `tokenStore.set(token)`, set `this.identity` from the response, clear pendingCode,
     then continue as today; on failure show the "link expired" modal above (stay on the choice step if the
     user has a stored token, otherwise offer stepToken). The redeem must happen on this explicit click only
     — never in begin() or on a timer.
   - `differentToken()`: rename the label to "Use a different account"; before clearing the stored token call
     `POST /auth/logout` best-effort (ignore failures), then clear and go to stepToken as today.
   - Success screen after the upload request returns 202: say that the upload is queued and that the user will
     get a Discord ping once it's live (usually 1–2 minutes) or if it is rejected.
4. Keep stepToken (paste a `/token` token) fully working.
5. Docs: AGENTS.md "The web page" section and README "Adding a mod" (the Discord button flow is now the
   primary way; `/token` is the alternative).

## Offline verification
- node tests in `worker/test/upload-lib.test.js`: parseLoginHash accepts/rejects (empty, wrong prefix, extra
  params, query-string style `?login=`, too short); authUrl derivation; peekCode/redeemCode map 200/404/410
  and network failures with a fake fetch.
- Static check that the redeem call appears only in `choose()` and peek only in `stepLoginPeek` (grep).
- Browser test against a local stub: serve `site/` statically with a tiny stub server implementing the three
  endpoints + `/whoami` (and `config.json` pointing at it). Use a headless browser if one is available or can
  be installed in a temp dir OUTSIDE the repo (playwright/puppeteer) — do not add it to the repo. Checklist:
  (a) load `#login=<valid>`: address bar cleaned, wizard shows "Signed in as X", NO redeem request yet;
  (b) click Upload -> exactly one redeem, token stored in localStorage, flow continues; (c) reload and open the
  wizard -> no login needed (stored session); (d) open the same link again -> "expired or used" modal;
  (e) a stale link with a valid stored session continues silently; (f) "Use a different account" calls logout
  then shows the token field. If no browser is obtainable, say so and list the checklist as untested.
- Existing node tests still pass.

## Live deployment and verification (you have the credentials — do it)
1. Commit and push to `main`; the push to `site/**` triggers `deploy-site.yml` (watch with `gh run watch`).
   Confirm with curl that the live `index.html`/`upload-flow.js` contain the new code and the response has
   the referrer meta tag.
2. Live browser run (if you have a headless browser): the live Worker only allows the Pages origin for CORS,
   so test the real thing at `https://jordgubbarnab55-cloud.github.io/ModCatalog/#login=<code>`:
   seed a login code into remote D1 (Plan 1's live section shows how; use the owner's Discord id) right before
   navigating, then check (a), (b), (d) above against the real Worker; afterwards confirm with `GET /whoami`
   using the token the browser stored that it identifies the owner, then `POST /auth/logout`.
   Without a browser, do the equivalent API sequence with curl and report the browser part as a Human check.
3. Delete any seeded rows.

## Out of scope
Worker changes, Discord button, forum.

## Human checks to report
Click the real Discord button (after Plan 2), follow the link, confirm the wizard opens signed in, click
"Upload a new mod", reload and confirm you stay signed in.
