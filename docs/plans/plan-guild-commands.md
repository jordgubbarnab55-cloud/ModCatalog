# Plan: guild-scoped slash commands (retire global commands)

Status: **implemented; cutover complete** — guild `token` registered,
global `token` deleted, `ping` residue removed, verified via the API.
Two implementation deviations: (1) `DELETE .../commands/{id}` needs the
command's snowflake id, not its name, so the script lists the global
commands, locates `token` by name, and deletes by id (absent = success);
(2) runtime finding — the planned `token` + `revoke` subcommand never
appeared in any client for this app (subcommands render as top-level
menu entries; those did not render at all — checked desktop + mobile),
so the command is now a bare, parameter-free `/token`; revoke = mint
again and ignore the new token (one active token per user). The
Worker's legacy `token revoke` subcommand path is retained. (3) One
small Worker fix was needed despite the "no Worker changes" decision:
current Discord interaction `member` objects have no top-level `id` —
the user id is nested at `member.user.id` (the handler now checks
`member.id`, `member.user.id`, and the DM `user.id` in that order).
(4) The flat inline 200 response was rejected by Discord ("didn't
respond in time" despite a <500 ms 200) — the Worker now uses the
documented canonical flow: immediate 202 ACK (no body), then
`POST /interactions/{id}/{token}/callback` with
`{type: 4, data: {content, flags: 64}}` (verified live: the user sees
the ephemeral reply). Remaining plan step: the in-Discord visual check
(§4 step 4, minus `token revoke`) — now satisfied.
Motivation: global slash-command propagation is slow and flaky (a command can
take minutes-to-hours after the bot joins a server). Guild (server) commands
appear **instantly**. Decision: `/token` will be registered **per guild only**;
no global registrations at all.

## 1. Current state

- `worker/scripts/register-commands.mjs` does one `PUT /applications/{appId}/
  /commands` (global) with the single `token` command (subcommand `revoke`).
- The Worker (`worker/src/index.js`, `handleDiscord`) routes purely on the
  command **name** (`token` / `token revoke`). It does not inspect
  `guild_id`, `channel`, or context — **it already works identically for
  guild- and global-scoped interactions.**
- Token storage is keyed by Discord **user id** (`tok:<sha256>`,
  `user:<discordId>`), independent of where the token was minted.
- Live residue to clean up: throwaway `ping` guild command in guild
  `1565286417968398356` (id `1565331467377311774`), and the global `token`
  command (id `1565303852956131431`) after cutover.

## 2. Design decisions

| Topic | Decision | Rationale |
|---|---|---|
| Where commands live | Guild commands only, one `PUT .../guilds/{id}/commands` per server | Instant propagation; Discord docs: guild commands apply to that server only |
| Which servers | `DISCORD_GUILD_IDS` (comma-separated) **or** auto-discovery via `GET /users/@me/guilds` when unset | Owner-explicit by default; auto-discovery is convenient |
| Retiring global | Script deletes the global `token` command **only after** all target-guild registrations succeeded | No gap where the command exists nowhere |
| New server later | Re-run the script (owner op, seconds). No auto-registration | The bot token must never live in the long-running Worker; the script already reads it from the environment at run time and stores nothing |
| Token scoping | **Unchanged**: a minted token is a bearer valid for uploads regardless of minting server; ownership/`ADMIN_DISCORD_IDS` stay keyed by Discord user id | Keeps the existing ownership model; per-server token scoping (`guild:<id>:<user>`) is a possible follow-up if the catalog is ever multi-tenant per server — out of scope here |
| Worker code | **No change** | Routing is name-based; signature check is context-agnostic |

## 3. Changes

### 3.1 `worker/scripts/register-commands.mjs` (rewrite)

Keep the CLI shape and env-var contract, add:

- `DISCORD_GUILD_IDS` (comma-separated) — explicit target list; when absent,
  the script lists the bot's own guilds (`GET /users/@me/guilds`) and uses
  all of them.
- Per guild: **bulk `PUT /applications/{appId}/guilds/{guildId}/commands`**
  with the full command set (Discord's guild endpoint is a full replace —
  this is also how stale/duplicate registrations are cleared).
- Per-guild failure isolation: a guild the bot is not a member of yields
  403 — collect, continue, exit non-zero at the end with the failure list
  (one bad server must not block the rest, mirroring the pipeline's
  per-package rule).
- `--retire-global`: after **all** target guilds succeeded,
  `DELETE /applications/{appId}/commands/token` (ignore 404). First cutover
  runs with this flag; later runs without it.
- `--dry-run`: print the exact requests without sending.
- Output: one line per guild (`registered|failed|skipped <guildId> <guildName>`),
  final summary, exit code 0 only if zero failures.

Testability: extract
`registerForGuilds(appId, token, guilds, fetchImpl, opts)` and
`retireGlobal(appId, token, fetchImpl)` so the existing
`node --test` suite (mock-`fetch` style, like the Worker tests) can cover:
happy path, per-guild 403 isolation, `--retire-global` ordering (delete only
when all succeeded), delete-404 tolerance, and bulk-PUT payload shape.

### 3.2 `worker/README.md` + `SETUP.md` (Part 4, step 13)

- New-server procedure: invite bot → re-run
  `DISCORD_APP_ID=… DISCORD_BOT_TOKEN=… node scripts/register-commands.mjs`.
- Note that commands appear **instantly** after registration (no waiting),
  and that a server where the bot was removed keeps its registration
  harmless (the commands just don't resolve there) — re-run after re-invite.

### 3.3 No other code changes

`worker/src/index.js`, `build.py`, the KV schema, the web pages: untouched.

## 4. Migration procedure (no window where the command exists nowhere)

1. Deploy the new script (repo push; nothing to deploy — Worker unchanged).
2. Delete the throwaway `ping` guild command
   (`DELETE .../guilds/1565286417968398356/commands/1565331467377311774`).
3. Run the script with `--retire-global` targeting the owner's server(s)
   (auto-discovery covers the current single guild).
4. Verify in the server: `/token` visible **immediately**; run it, check the
   ephemeral reply, then `/token revoke`.
5. Confirm the global command is gone
   (`GET /applications/{appId}/commands` → `[]`).
6. Re-run the Part 5 smoke test end-to-end (token → upload → catalog).

Rollback (if anything is wrong): re-PUT the global `token` command via the
API (one request); guild registrations can be removed with the same bulk
`PUT .../guilds/{id}/commands` with `[]`.

## 5. Residual caveats

- **Multi-server ≠ multi-tenant**: the same user's token works from any
  server (and the ownership check is user-id-based by design). If per-server
  scoping is ever wanted, that is a token-schema + Worker change, separate
  from this plan.
- A server the bot is no longer a member of: its guild command record is
  inert until the bot rejoins; the script's next run refreshes it.
- Bulk `PUT` is full-replace: if the app ever gains a second command, the
  script's command array is the single source of truth (no partial updates).

## 6. Implementation record (2026-10-30)

- `worker/scripts/register-commands.mjs` rewritten as specified:
  `COMMANDS` (the bare `token`), `listGuilds`, `registerForGuilds`,
  `retireGlobal`, `runCli` — all extractable/testable; the CLI reads
  `DISCORD_APP_ID` / `DISCORD_BOT_TOKEN` from the environment and never
  stores them.
- `worker/test/register-commands.test.js` added (mock-`fetch` style, same
  as the Worker tests): payload shape, per-guild 403 isolation,
  `--retire-global` ordering (delete only after all registered), 404
  tolerance, `--dry-run`, list-error handling. Full suite green
  (18 → 47 tests).
- Live cutover executed: throwaway `ping` deleted (HTTP 204); guild
  `token` registered in guild `1565286417968398356` (command ID
  `1565350313345683598`); global `token` deleted;
  `GET /applications/{appId}/commands` → `[]`.
- Docs updated: `worker/README.md` (registration section, new-server
  procedure, instant-propagation note, one-token-per-user rule),
  `SETUP.md` step 13, `AGENTS.md`.

Deviations from the original spec (all verified live):

- **Bare `/token`, no parameters** (2026-10-30): subcommand-bearing
  commands (type 2 with subcommand options) **never rendered** for this
  application — not in any client (desktop or mobile), and the API
  confirmed the registration. The command is a bare, parameter-free
  `/token`; re-running it mints a new token that replaces (revokes) the
  user's current one — one active token per user. The Worker still
  accepts the legacy `token revoke` subcommand path for backward
  compatibility with the app, but the registered command has no options.
- **`retireGlobal` uses list-then-delete by snowflake ID** (2026-10-30):
  Discord's `DELETE /applications/{appId}/commands/{id}` requires a
  snowflake command ID, not a name. The script lists global commands,
  locates `token` by name, deletes by ID. An absent command counts as
  success.
- **`member.user.id`** (2026-10-30): the live interaction payload's
  `member` object has **no top-level `id`** (only `roles/guild_id/
  join_timestamp/…` + nested `user`); the token was minting for "null"
  and the same user re-minted over their own token. The handler now
  reads `member.id` → `member.user.id` → DM `user.id` (verified live: one
  `/token` = one usable token, same user).
- **202 + callback response** (2026-10-30): a flat inline 200 body is
  **not accepted** — Discord never delivered the reply ("didn't respond
  in time"). The handler now ACKs with **202 (no body)** and POSTs the
  reply to `/interactions/{id}/{token}/callback` (verified live: the
  ephemeral token reply renders in the channel).
- **GitHub User-Agent** (2026-10-30): GitHub's API 403s any request
  without a `User-Agent` header; the Worker's fetch sends none by
  default, so every upload died at the release lookup with
  `500 / error 1101`. All three GitHub calls now send
  `User-Agent: ModCatalog-Worker` (verified live via the Part 5 smoke
  test). (The `GITHUB_TOKEN` secret also had to be re-set that day —
  `wrangler secret put` — after earlier secret churn.)
- **`GhClient.download_asset`** (2026-10-30, `build.py`): `gh release
  download --pattern` keeps the asset's original name in the cwd, but
  the inbox drain expects the file at its `dest` (`package.zip`) — the
  first live run rejected every upload with `No such file or directory`.
  Fixed by renaming to `dest` after the download (commit `15786e1`).

## 7. Status

Part 1: complete (rewritten, tested).
Part 2: complete (docs).
Part 3: complete (cutover executed live; all verification steps passed —
`/token` visible instantly, ephemeral reply works, global list empty).
Part 4: complete (step 13 rewritten for guild scoping).
Part 5: **complete** — `scripts/smoke-test.sh` uploaded a zip using a
Discord-minted token: Worker → 202 `queued` → `Process inbox` workflow
(validated the trailer, re-homed the asset to `mod-94daad40…`) → the mod
appeared in `catalog.json` within the 5-minute poll, ownership = the
token's Discord user. This surfaced and fixed the last two runtime
defects (the GitHub User-Agent 403 and the `GhClient.download_asset`
path mismatch, see deviations).

**Overall status: implemented — cutover complete, end-to-end smoke test
passed (2026-10-30).**
