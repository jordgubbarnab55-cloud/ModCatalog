# SETUP.md — ordered owner runbook

Everything here needs your accounts (Discord / GitHub / Cloudflare).
Work on the `migration` branch was done **without** touching any of them;
every step below is a live action. Do them **in order**.

Expect a few minutes of downtime (the site, the ModManager Browse tab, and
the old `assets/*.zip` download links) between **step 5 and step 7**,
because moving `index.html` into `site/` breaks the old Pages build.

**Part 1 — Gather values (no repo changes yet)**

1. **Discord application.** https://discord.com/developers/applications →
   *New Application*. On *General Information* copy the **Application ID**
   and the **Public Key**. On the *Bot* tab, *Reset Token* and copy the
   **bot token** (only needed to register the commands; keep it out of the
   repo). In Discord itself: Settings → Advanced → enable *Developer Mode*,
   right-click your own name → *Copy User ID* (this is your admin id).
2. **GitHub token for the Worker.** GitHub → Settings → Developer
   settings → Fine-grained tokens → *Generate new token*. Resource owner:
   your account. Repository access: **only `ModCatalog`**. Repository
   permissions: **Contents: Read and write**, **Actions: Read and write**
   (metadata read is automatic). Set an expiry and put a reminder in your
   calendar — uploads stop working when it expires. Copy the token.
3. **Cloudflare.** Create a free account. In `worker/`, run
   `npx wrangler login`.

**Part 2 — Cut over the GitHub side**

4. Review the `migration` branch and merge it into `main`.
5. **Repo settings (do this immediately after merging):**
   - Settings → Pages → *Source* = **GitHub Actions** (legacy branch
     deploys no longer apply).
   - Settings → Actions → General → *Workflow permissions* =
     **Read and write permissions**.
   - Settings → Secrets and variables → Actions → *Variables* → add
     `ADMIN_DISCORD_IDS` = your Discord user id (step 1; comma-separated
     for several admins).
6. **Actions tab → run `Seed legacy mods` once.** It treats the zips in
   `legacy-assets/` as admin uploads: creates the `inbox` release, the
   three `mod-<guid>` releases (with covers), writes `site/catalog.json`
   and deploys Pages.
7. **Verify.**
   - Open `https://jordgubbarnab55-cloud.github.io/ModCatalog/` — the three
     cards and covers show; a download starts (the `download` attribute is
     ignored cross-origin, but GitHub serves release assets as attachments).
   - Point ModManager's Browse tab at
     `https://jordgubbarnab55-cloud.github.io/ModCatalog/catalog.json`
     and download a mod. **This checks that the app follows GitHub's
     302 redirect** — if it does not, the fix is on the app side (enable
     automatic redirect following).
   - Optionally run **Rebuild catalog** and confirm `site/catalog.json`
     does not change.
8. Delete the old zips:
   ```
   git rm -r legacy-assets && git commit -m "Remove legacy assets after seeding" && git push
   ```
   (They stay in git history; no rewrite needed.)

**Part 3 — Cloudflare Worker**

9. In `worker/`:
   - `npx wrangler kv namespace create TOKENS` (older wrangler:
     `npx wrangler kv:namespace create TOKENS`). Paste the printed id into
     `wrangler.toml` (`[[kv_namespaces]] id = "..."`).
   - Fill `GITHUB_OWNER` (= `jordgubbarnab55-cloud`), `GITHUB_REPO`
     (= `ModCatalog`) and `ALLOWED_ORIGIN`
     (= `https://jordgubbarnab55-cloud.github.io`) in `wrangler.toml`.
10. `npx wrangler secret put DISCORD_PUBLIC_KEY` (the key from step 1),
    then `npx wrangler secret put GITHUB_TOKEN` (the token from step 2).
11. `npx wrangler deploy`. The first deploy asks you to register a
    `workers.dev` subdomain. Note the printed URL, e.g.
    `https://modcatalog.<you>.workers.dev`.
12. Put that URL into `site/config.json` as `uploadUrl` (replace
    `REPLACE_ME_WORKER_URL`), commit and push — the push to `site/**`
    redeploys Pages (workflow `Deploy site`).

**Part 4 — Discord**

13. Developer portal → *General Information* → set **Interactions Endpoint
    URL** to `<worker-url>/discord` and save. Discord sends a signed test
    request; the save fails if the secret or the URL is wrong. Then
    register the commands:
    ```
    DISCORD_APP_ID=<from step 1> DISCORD_BOT_TOKEN=<from step 1> node scripts/register-commands.mjs
    ```
    (run from `worker/`; global commands can take a few minutes to appear).
    Finally, install the app to your server (the *Installation* tab link,
    or the OAuth2 URL generator with the `applications.commands` scope).

**Part 5 — End-to-end test**

14. In Discord run **`/token`** and copy the token. Then:
    ```
    worker/scripts/smoke-test.sh <worker-url> <token> <some-mod.zip>
    ```
    Expect `202`, then the mod appearing in the catalog within a few
    minutes. Also try:
    - a file **over 100 MB** → should get `413`;
    - a **wrong token** → should get `401`;
    - an upload from `<catalog URL>/upload.html` (the page should report
      it in the catalog within ~3 minutes of the 202).
    - If a ~90 MB upload fails with a CPU-time error, report it to the
      maintainers before changing anything (free-plan CPU limit, 10 ms).

**Troubleshooting**

- Uploads return **503** → the `inbox` release does not exist (run
  `Seed legacy mods` or `Process inbox` once).
- Uploads return **502** → the GitHub token is wrong or expired (step 2).
- A mod stuck in the `inbox` release → the `Process inbox` workflow
  rejected it; read that run's log for the reason.
- The page says "upload is not configured yet" → `site/config.json`
  still holds the placeholder (step 12).
- The catalog is missing or corrupt → run **Rebuild catalog**; the
  releases are the source of truth.
