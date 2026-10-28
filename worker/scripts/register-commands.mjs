// One-off: register the global slash commands for the Discord application.
//
// Usage (owner, from anywhere; needs Node 18+):
//   DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs
//
// Reads both values from the environment AT RUN TIME and never stores them.
// (The bot token is only needed for this registration; the Worker itself
// authenticates Discord requests with the app's public key, not the token.)

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_BOT_TOKEN;
if (!appId || !token) {
  console.error("usage: DISCORD_APP_ID=... DISCORD_BOT_TOKEN=... node scripts/register-commands.mjs");
  process.exit(1);
}

const commands = [
  {
    name: "token",
    description: "Mint (and replace) your ModCatalog upload token",
    options: [
      {
        name: "revoke",
        type: 2, // Subcommand
        description: "Revoke your current upload token",
      },
    ],
  },
];

const res = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, {
  method: "PUT",
  headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});

if (!res.ok) {
  console.error(`registering commands failed: HTTP ${res.status}`);
  console.error(await res.text());
  process.exit(1);
}
console.log(`registered ${commands.length} global command(s) for application ${appId}`);
console.log("(global commands can take a few minutes to appear in Discord)");
