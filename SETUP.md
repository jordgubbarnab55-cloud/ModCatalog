# SETUP.md — ordered owner runbook

Everything here needs your accounts (Discord / GitHub / Cloudflare).
Every step below is a live action. Do them **in order**.

**Part 1 — Gather values (no repo changes yet)**

1. **Discord application.** https://discord.com/developers/applications →
   *New Application*. On *General Information* copy the **Application ID**
   and the **Public Key**. On the *Bot* tab, *Reset Token* and copy the
   **bot token** (only needed to register the commands; keep it out of
   the repo). In Discord itself: Settings → Advanced → enable *Developer
   Mode*, right-click your own name → *Copy User ID* (this is your admin
   id).
2. **GitHub token for the Worker.** GitHub → Settings → Developer
   settings → Fine-grained tokens → *Generate new token*. Resource owner:
   your account. Repository access: **only `ModCatalog`**. Repository
   permissions: **Contents: Read and write**, **Actions: Read and write**
   (metadata read is automatic). Set an expiry and put a reminder in your
   calendar — uploads stop working when it expires. Copy the token.
3. **Cloudflare.** Create a free account. In `worker/`, run
   `npx wrangler login`.

**Part 2 — GitHub repo setup**

4. **Repo settings:**
   - Settings → Pages → *Source* = **GitHub Actions**.
   - Settings → Actions → General → *Workflow permissions* =
     **Read and write permissions**.
   - Settings → Secrets and variables → Actions → *Variables* → add
     `ADMIN_DISCORD_IDS` = your Discord user id (step 1; comma-separated
     for several admins).
5. **Verify.**
   - Open `https://jordgubbarnab55-cloud.github.io/ModCatalog/` — the
     page loads (empty catalog at first).
   - Run the **Process inbox** workflow once. It also creates the empty
     `inbox` release the Worker's upload endpoint requires (a fresh repo
     answers uploads with `503` until it exists).
   - Point ModManager's Browse tab at
     `https://jordgubbarnab55-cloud.github.io/ModCatalog/catalog.json`
     and refresh (an empty list at this point).
6. **Actions tab → run `Seed legacy mods`** (optional; only if the
   `legacy-assets/` packages are present in the repo). It asks for a
   Discord **user id** and **username** (they own the seeded mods, and
   the username is published as their author — every package in the
   catalog belongs to a verified account). It treats the zips in
   `legacy-assets/` as uploads by that account: creates the `inbox`
   release, the per-mod `mod-<identifier slug>-<hash>` releases (with
   covers), writes `site/catalog.json` and deploys Pages. (Locally:
   `python build.py process --from-dir legacy-assets
   --as-uid <id> --as-username <name>`; it refuses to run without both.)

**Part 3 — Cloudflare Worker**

7. In `worker/`:
   - `npx wrangler kv namespace create TOKENS` (older wrangler:
     `npx wrangler kv:namespace create TOKENS`). Paste the printed id into
     `wrangler.toml` (`[[kv_namespaces]] id = "..."`).
   - Fill `GITHUB_OWNER` (= `jordgubbarnab55-cloud`), `GITHUB_REPO`
     (= `ModCatalog`) and `ALLOWED_ORIGIN`
     (= `https://jordgubbarnab55-cloud.github.io`) in `wrangler.toml`.
8. `npx wrangler secret put DISCORD_PUBLIC_KEY` (the key from step 1),
   then `npx wrangler secret put GITHUB_TOKEN` (the token from step 2).
9. `npx wrangler deploy`. The first deploy asks you to register a
   `workers.dev` subdomain. Note the printed URL, e.g.
   `https://modcatalog.<you>.workers.dev`.
10. Put that URL into `site/config.json` as `uploadUrl` (replace
    `REPLACE_ME_WORKER_URL`), commit and push — the push to `site/**`
    redeploys Pages (workflow `Deploy site`).
    **Catalog title:** set `title` in the same file (e.g.
    `"title": "XYZ Community Mods"`); it is the page heading, the browser
    tab title and the catalog's `name` (what ModManager's Browse tab
    shows). An optional `description` sets the catalog's `description`
    (not shown on the page). Absent or blank, they default to
    "Mod Catalog" and a generic description. `Deploy site` applies them to
    the deployed `catalog.json` (`python build.py retitle`); the committed
    copy follows on the next catalog run (or run **Rebuild catalog**).

**Part 4 — Discord**

11. Developer portal → *General Information* → set **Interactions Endpoint
    URL** to `<worker-url>/discord` and save. Discord sends a signed test
    request; the save fails if the secret or the URL is wrong. Then
    register the commands:
    ```
    DISCORD_APP_ID=<from step 1> DISCORD_BOT_TOKEN=<from step 1> node scripts/register-commands.mjs
    ```
    (run from `worker/`; add `--retire-global` to also delete a global
    `token` command once every target guild is registered). The commands
    are **guild-scoped and appear instantly** — no minutes-to-hours wait.
    Later, for a new server: invite the bot there and re-run the same
    command. Finally, install the app to your server (the *Installation*
    tab link, or the OAuth2 URL generator with the `applications.commands`
    scope).

**Part 5 — End-to-end test**

12. In Discord run **`/token`** and copy the token. Then:
    ```
    worker/scripts/smoke-test.sh <worker-url> <token> <some-mod.zip>
    ```
    Expect `202`, then the mod appearing in the catalog within a few
    minutes. Also try:
    - a file **over 100 MB** → should get `413`;
    - a **wrong token** → should get `401`;
    - an upload through "Upload a mod" on `<catalog URL>` (the dialog should
      report it in the catalog within ~3 minutes of the 202);
    - the mod downloaded from ModManager's Browse tab — **this checks
      that the app follows GitHub's 302 redirect** (the `download`
      attribute is ignored cross-origin, but GitHub serves release assets
      as attachments). If it does not download, the fix is on the app
      side (enable automatic redirect following).
    - If a ~90 MB upload fails with a CPU-time error, report it to the
      maintainers before changing anything (free-plan CPU limit, 10 ms).

**Troubleshooting**

- Uploads return **503** → the `inbox` release does not exist (run
  `Process inbox` once; its build step creates it).
- Uploads return **502** → the GitHub token is wrong or expired (step 2).
- A mod stuck in the `inbox` release → the `Process inbox` workflow
  rejected it; read that run's log for the reason.
- The page says "upload is not configured yet" → `site/config.json`
  still holds the placeholder (step 10).
- The catalog is missing or corrupt → run **Rebuild catalog**; the
  releases are the source of truth.
