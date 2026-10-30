// One-off: register the ModCatalog slash commands, guild-scoped.
//
// Usage (owner, from anywhere; needs Node 18+):
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
//
// Env:
//   DISCORD_GUILD_IDS  comma-separated target guild ids. When absent, the
//                      script auto-discovers the bot's own guilds
//                      (GET /users/@me/guilds) and targets all of them.
// Flags:
//   --retire-global  after ALL target guilds registered successfully,
//                    DELETE the legacy global "token" command (404 is ok).
//                    First cutover runs with this flag; later runs without.
//   --dry-run        print the exact mutation requests without sending them
//                    (auto-discovery is a read and still runs).
//
// Commands are registered per guild (bulk PUT /applications/{appId}/
// guilds/{guildId}/commands — a full replace, so stale registrations are
// cleared too) and appear in Discord immediately. A guild the bot is not a
// member of yields 403: it is collected and the rest proceed; the script
// exits non-zero at the end with the failure list.
//
// Reads both values from the environment AT RUN TIME and never stores them.
// (The bot token is only needed for this registration; the Worker itself
// authenticates Discord requests with the app's public key, not the token.)

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://discord.com/api/v10";

// The command set is the single source of truth: the guild endpoint is a
// full replace, so adding a second command means adding it here.
// Intentionally parameter-free: commands whose only entry points are
// subcommands never appeared in this app's clients (subcommands render as
// top-level menu entries; those did not render at all), so a bare /token
// is the mint. "Revoke" = mint again and ignore the new token (one active
// token per user). The Worker still accepts a legacy `token revoke`
// subcommand if one is ever registered again.
export const COMMANDS = [
  {
    name: "token",
    description: "Mint a new upload token (a new mint invalidates the previous one)",
  },
];

export async function listGuilds(token, fetchImpl) {
  const res = await fetchImpl(`${API}/users/@me/guilds`, {
    method: "GET",
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    throw new Error(`listing the bot's guilds failed: HTTP ${res.status}`);
  }
  return (await res.json()).map((g) => ({ id: g.id, name: g.name }));
}

// Bulk-PUT the full command set into each guild (Discord's guild endpoint
// is a full replace). One bad guild never blocks the rest: 403 (the bot is
// not a member) is collected as "skipped", other errors as "failed".
export async function registerForGuilds(appId, token, guilds, fetchImpl, opts = {}) {
  const { dryRun = false } = opts;
  const registered = [];
  const skipped = [];
  const failed = [];
  for (const guild of guilds) {
    const url = `${API}/applications/${appId}/guilds/${guild.id}/commands`;
    if (dryRun) {
      console.log(`[dry-run] PUT ${url} ${JSON.stringify(COMMANDS)}`);
      registered.push(guild);
      continue;
    }
    let res;
    try {
      res = await fetchImpl(url, {
        method: "PUT",
        headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(COMMANDS),
      });
    } catch (err) {
      failed.push({ guild, status: null, detail: String(err) });
      continue;
    }
    if (res.ok) {
      registered.push(guild);
    } else if (res.status === 403) {
      skipped.push({ guild, status: 403 });
    } else {
      let detail = "";
      try { detail = await res.text(); } catch { /* no body */ }
      failed.push({ guild, status: res.status, detail });
    }
  }
  return { registered, skipped, failed };
}

// Delete the legacy global "token" command. Only call after every target
// guild succeeded (that ordering is enforced by runCli / main). The delete
// endpoint needs the command's snowflake id, so we locate "token" in the
// global list first; a missing command is an already-gone success (the
// 404 case the plan speaks of). An explicit 404 from the DELETE itself is
// tolerated too.
export async function retireGlobal(appId, token, fetchImpl, opts = {}) {
  const { dryRun = false } = opts;
  const listUrl = `${API}/applications/${appId}/commands`;
  if (dryRun) {
    console.log(`[dry-run] GET ${listUrl}  (locate "token")`);
    console.log(`[dry-run] DELETE ${listUrl}/<id of "token">  (only if present)`);
    return { ok: true, deleted: false, dryRun: true };
  }
  let res;
  try {
    res = await fetchImpl(listUrl, {
      method: "GET",
      headers: { Authorization: `Bot ${token}` },
    });
  } catch (err) {
    return { ok: false, status: null, detail: String(err) };
  }
  if (!res.ok) {
    let detail = "";
    try { detail = await res.text(); } catch { /* no body */ }
    return { ok: false, status: res.status, detail };
  }
  const commands = await res.json();
  const target = commands.find((c) => c.name === "token");
  if (!target) return { ok: true, deleted: false };

  let del;
  try {
    del = await fetchImpl(`${listUrl}/${target.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bot ${token}` },
    });
  } catch (err) {
    return { ok: false, status: null, detail: String(err) };
  }
  if (del.status === 404) return { ok: true, deleted: false };
  if (del.ok) return { ok: true, deleted: true };
  let detail = "";
  try { detail = await del.text(); } catch { /* no body */ }
  return { ok: false, status: del.status, detail };
}

// registerForGuilds, then — only if retireGlobal was requested and ALL
// target guilds registered (zero skipped, zero failed) — retire the global
// command. Returns the combined results.
export async function runCli(appId, token, guilds, fetchImpl, opts = {}) {
  const { dryRun = false, retireGlobal: wantRetire = false } = opts;
  const { registered, skipped, failed } = await registerForGuilds(appId, token, guilds, fetchImpl, { dryRun });
  let retire = null;
  if (wantRetire) {
    if (skipped.length === 0 && failed.length === 0) {
      retire = await retireGlobal(appId, token, fetchImpl, { dryRun });
    } else {
      retire = { ok: false, skipped: true };
    }
  }
  return { registered, skipped, failed, retire };
}

async function main() {
  const appId = process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_BOT_TOKEN;
  const dryRun = process.argv.includes("--dry-run");
  const wantRetire = process.argv.includes("--retire-global");
  if (!appId || !token) {
    console.error("usage: DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs [--retire-global] [--dry-run]");
    process.exit(2);
  }

  const explicit = (process.env.DISCORD_GUILD_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let guilds;
  if (explicit.length > 0) {
    guilds = explicit.map((id) => ({ id, name: id }));
  } else {
    if (dryRun) console.log("[dry-run] auto-discovery is a read: GET /users/@me/guilds runs as usual");
    guilds = await listGuilds(token, fetch);
  }
  if (guilds.length === 0) {
    console.error("no target guilds (DISCORD_GUILD_IDS empty and the bot is in no guilds)");
    process.exit(1);
  }

  const { registered, skipped, failed, retire } = await runCli(appId, token, guilds, fetch, {
    dryRun,
    retireGlobal: wantRetire,
  });

  for (const g of registered) console.log(`registered ${g.id} ${g.name}`);
  for (const s of skipped) console.log(`skipped ${s.guild.id} ${s.guild.name} (HTTP ${s.status} — bot not a member?)`);
  for (const f of failed) console.log(`failed ${f.guild.id} ${f.guild.name} (HTTP ${f.status ?? "n/a"}${f.detail ? ` ${f.detail}` : ""})`);
  console.log(`summary: ${registered.length} registered, ${skipped.length} skipped, ${failed.length} failed`);

  let bad = skipped.length > 0 || failed.length > 0;
  if (wantRetire) {
    if (retire && retire.skipped) {
      console.log('retire-global: not run (not every target guild registered)');
    } else if (retire) {
      if (retire.ok) {
        console.log(`retire-global: global "token" command ${retire.dryRun ? "would be deleted" : retire.deleted ? "deleted" : "was already gone (404)"}`);
      } else {
        bad = true;
        console.log(`retire-global: delete failed (HTTP ${retire.status ?? "n/a"}${retire.detail ? ` ${retire.detail}` : ""})`);
      }
    }
  }
  process.exit(bad ? 1 : 0);
}

// Run as a CLI, not when imported by the test suite.
const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) await main();
