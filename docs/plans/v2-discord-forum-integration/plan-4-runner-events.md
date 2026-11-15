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

# PLAN 4 — Runner side: structured outcomes + signed callback to the Worker

## Goal
After process-inbox publishes or rejects uploads, the runner sends a signed HTTP callback listing the
outcomes. The Worker receiver is a separate plan (Plan 5) built against the contract below. Offline tests
cover everything; then verify a real run on GitHub Actions.

Depends on: nothing (Plan 5 consumes the contract).

## Read first
- build.py: the `process` command, Processor (_target, apply_metadata, acceptance + rejection points),
  entry_from_meta, raw_group_source/set_members, the code that sweeps stalled groups, the argparse section at
  the bottom, PackageClient + LocalClient (offline fake).
- tests/test_ingest.py, tests/test_build.py (how Processor is driven offline with LocalClient)
- .github/workflows/process-inbox.yml and .github/actions/commit-and-deploy/action.yml
- AGENTS.md "Workflows" and "Pipeline" sections.

## Contract (Plan 5 implements the receiver; do not deviate)
```
POST <CATALOG_CALLBACK_URL>/catalog/events
Headers: Content-Type: application/json
         X-Catalog-Signature: <hex HMAC-SHA256(secret, rawBodyBytes)>
Body:    {"ts": <unix seconds>, "events": [ <Event>, ... ]}   (max 10 events per request; chunk if more)
Event (JSON object):
  eventId      string   unique & stable per outcome
                        (published: "<identKeyLower>:<package sha256>"; rejected: "rej:<uploaderId>:<inbox group or asset id>")
  status       "published" | "rejected"
  mode         "new" | "update" | null     (null when rejected before it was determined)
  uploaderId   string   Discord id
  uploaderName string   Discord username
  reason       string   rejected only; one human-readable line, <= 300 chars, no URLs of private assets
  title, version, description, author, identifier   strings (published; identifier = the locked mod id)
  tags         string[] (published; catalog-vocabulary tags, may be empty)
  gameVersion  string|null
  fileUrl      string   stable release-asset URL of the package (published)
  coverUrl     string|null
  size         integer bytes
  sha256       string   (published)
  assetName    string
For rejected events include whatever of title/version/identifier is known (else null).
```

## Design
1. build.py: give Processor a results list. Every accepted package appends a "published" event built from the
   same data as the catalog entry (reuse entry_from_meta output: do not re-derive fields); every rejection
   point (including groups swept for being stalled > 7 days: reason "incomplete upload expired") appends a
   "rejected" event with the human reason already logged. One bad package must still not block others.
   Incomplete groups waiting for more parts emit nothing.
2. `process` gains `--results-file PATH` (JSON array of events, written atomically at the end, also written
   as `[]` when there were none, and written even if some packages were rejected). `rebuild` emits nothing.
3. New subcommand `python build.py notify --results PATH [--url URL] [--secret S]`: URL/secret default to
   env `CATALOG_CALLBACK_URL` and `CATALOG_CALLBACK_SECRET`. If either is missing: print a one-line note and
   exit 0. Reads the events, chunks by 10, signs and POSTs each chunk with urllib (stdlib), one retry after
   2 s on network error or 5xx, never raises (always exit 0; log failures). Never print the secret. Keep the
   HMAC signing and chunking in small pure functions for testing.
4. process-inbox.yml: pass `--results-file inbox-results.json` to `build.py process`; add a step AFTER the
   commit-and-deploy step (so the site is live before the ping): `if: always()`,
   `python build.py notify --results inbox-results.json` with env `CATALOG_CALLBACK_URL` /
   `CATALOG_CALLBACK_SECRET` from repository secrets, and `continue-on-error: true`. A missing results file
   must not fail the step.
5. seed-legacy / from-dir processing may also write a results file but must not notify.
6. Docs: AGENTS.md workflows/pipeline sections.

## Offline verification (`python -m unittest` from the repo root — check README/AGENTS for the exact command)
- Tests with LocalClient: a new-mod upload yields one 'published' event with mode 'new' and fields equal to
  the catalog entry; an update yields mode 'update'; a rejection (bad trailer, someone else's identifier,
  duplicate) yields a 'rejected' event with a reason and does not stop other packages in the same run; an
  incomplete group yields nothing; eventIds are stable across two runs of the same inputs where applicable and
  distinct otherwise.
- notify tests with a local `http.server` stub on 127.0.0.1: correct signature (recompute with hmac), header
  name, body shape, chunking of 25 events into 3 requests, retry on a 500 then success, exit 0 when the server
  is down, exit 0 and no request when env vars are missing.
- The existing pipeline/contract tests still pass; the generated `catalog.json` output is byte-identical to
  before for the same inputs (this plan must not change catalog output).
- Validate the workflow YAML parses (PyYAML if available, otherwise review by eye).

## Live deployment and verification (you have the credentials — do it)
1. Set the GitHub Actions secrets `CATALOG_CALLBACK_URL` (the Worker origin, no trailing slash) and
   `CATALOG_CALLBACK_SECRET` (the value of `secrets/forum_callback_secret.txt`; Plan 5 gives the Worker the
   same value). Use `gh secret set` (value on stdin). Commit and push to `main`.
2. Real end-to-end run: obtain a token for the owner id (seed a `manual` row in remote D1 as in Plan 1's live
   section; if Plan 1 is not deployed, STOP — Plan 1 is a prerequisite for live uploads), build a valid test
   package titled `ZZ Test Plan4`, `POST /upload` it in zip mode, then `gh run watch` the `process-inbox` run.
   Check in the run log: results file written with one 'published' event; the notify step ran and logged its
   outcome (a 404 from the Worker is expected until Plan 5 is deployed; if Plan 5 is already live expect 200).
   Check the catalog on Pages lists the mod. Then upload a second, deliberately invalid package (e.g. a zip with
   no valid trailer) and confirm a 'rejected' event with a readable reason in the log.
3. Make sure no secret value appears in the run logs (GitHub masks secrets; still check the notify step output).
4. Clean up: delete the test mod's release (`mod-*zztest*`), leftover `inbox` assets, dispatch `rebuild.yml`
   and confirm `catalog.json` no longer lists it; delete seeded D1 rows.

## Out of scope
The Worker receiver, Discord posting.

## Human checks to report
None required.
