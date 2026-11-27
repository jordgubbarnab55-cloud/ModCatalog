// One-off: post (or edit) the persistent "Upload or update a mod" button
// message in the #mods text channel.
//
// Usage (owner, from anywhere; needs Node 18+):
//   DISCORD_BOT_TOKEN=... MODS_CHANNEL_ID=... node scripts/post-mods-message.mjs [--edit <messageId> | --edit-current | --replace] [--dry-run]
//
// Env (read at run time, never stored):
//   DISCORD_BOT_TOKEN   `Authorization: Bot <token>`
//   MODS_CHANNEL_ID     the #mods text channel (type 0)
// Flags:
//   --edit <messageId>  PATCH the existing message instead of posting a new
//                       one (to refresh the copy or the buttons later).
//   --edit-current      PATCH the bot's newest button message in the channel
//                       (found among the last 100 messages); posts a new one
//                       when there is none.
//   --replace           post a new message, then delete every earlier button
//                       message of the bot among the last 100 messages.
//   --dry-run           print the exact mutation request without sending it.
//
// The message carries three buttons in one action row:
//   * "Upload or update a mod" (style 1)  -> custom_id "mods_upload"
//     (the Worker mints a one-time login code and replies ephemerally with
//     a link button to the site)
//   * "Check upload status" (style 2)     -> custom_id "mods_status"
//     (the Worker replies ephemerally with the clicker's last 3 uploads)
//   * "Sign out everywhere" (style 2)     -> custom_id "mods_signout"
//     (the Worker deletes all of the clicker's tokens)
// The Worker's /discord endpoint dispatches all three (worker/src/index.js).

const API = "https://discord.com/api/v10";

// The message payload: explanatory content + one action row with the three
// buttons. `buildModsMessage` is exported so a test can assert the shape.
export function buildModsMessage() {
  return {
    content:
      "**Share a mod** — click **Upload or update a mod** and the bot gives you " +
      "a private link to the website's uploader. The link works **once** and " +
      "expires in 5 minutes. **Check upload status** shows whether your last " +
      "uploads are waiting, published or rejected. **Sign out everywhere** " +
      "revokes your site login (and your `/token` token) on all devices.",
    components: [{
      type: 1, // one action row with all three buttons
      components: [
        { type: 2, style: 1, label: "Upload or update a mod", custom_id: "mods_upload" },
        { type: 2, style: 2, label: "Check upload status", custom_id: "mods_status" },
        { type: 2, style: 2, label: "Sign out everywhere", custom_id: "mods_signout" },
      ],
    }],
  };
}

// POST (or PATCH, when messageId is given) the payload into the channel.
// Returns { ok, status, messageId, detail }: a non-2xx Discord response is a
// failure (detail = the response text, truncated).
export async function postModsMessage(token, channelId, fetchImpl, opts = {}) {
  const { messageId = null, dryRun = false } = opts;
  const verb = messageId ? "PATCH" : "POST";
  const url = messageId
    ? `${API}/channels/${channelId}/messages/${messageId}`
    : `${API}/channels/${channelId}/messages`;
  const payload = buildModsMessage();
  if (dryRun) {
    console.log(`[dry-run] ${verb} ${url}`);
    console.log(JSON.stringify(payload, null, 2));
    return { ok: true, status: null, messageId: messageId || null, dryRun: true };
  }
  let res;
  try {
    res = await fetchImpl(url, {
      method: verb,
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, status: null, messageId: null, detail: String(err) };
  }
  let detail = "";
  try { detail = await res.text(); } catch { /* no body */ }
  if (res.ok) {
    let id = null;
    try { id = (JSON.parse(detail) || {}).id || null; } catch { /* not json */ }
    return { ok: true, status: res.status, messageId: id, detail };
  }
  return { ok: false, status: res.status, messageId: null, detail: detail.slice(0, 300) };
}

// The bot's own button messages (custom_id "mods_upload") among the last
// 100 messages of the channel, newest first. Returns { ok, ids, detail }.
export async function findModsMessages(token, channelId, fetchImpl) {
  const headers = { Authorization: `Bot ${token}` };
  try {
    const me = await fetchImpl(`${API}/users/@me`, { headers });
    if (!me.ok) return { ok: false, ids: [], detail: `users/@me HTTP ${me.status}` };
    const botId = (await me.json()).id;
    const res = await fetchImpl(`${API}/channels/${channelId}/messages?limit=100`, { headers });
    if (!res.ok) return { ok: false, ids: [], detail: `messages HTTP ${res.status}` };
    const ids = (await res.json())
      .filter((m) => m.author && m.author.id === botId &&
        (m.components || []).some((row) => (row.components || []).some((b) => b.custom_id === "mods_upload")))
      .map((m) => m.id);
    return { ok: true, ids };
  } catch (err) {
    return { ok: false, ids: [], detail: String(err) };
  }
}

// Deletes the given messages; returns the ids that could not be deleted
// (404 counts as deleted).
export async function deleteMessages(token, channelId, ids, fetchImpl) {
  const failed = [];
  for (const id of ids) {
    try {
      const res = await fetchImpl(`${API}/channels/${channelId}/messages/${id}`,
        { method: "DELETE", headers: { Authorization: `Bot ${token}` } });
      if (!res.ok && res.status !== 404) failed.push(id);
    } catch {
      failed.push(id);
    }
  }
  return failed;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.MODS_CHANNEL_ID;
  const dryRun = process.argv.includes("--dry-run");
  const editIdx = process.argv.indexOf("--edit");
  let messageId = editIdx > -1 && process.argv[editIdx + 1]
    ? process.argv[editIdx + 1]
    : null;
  const editCurrent = process.argv.includes("--edit-current");
  const replace = process.argv.includes("--replace");
  if (!token || !channelId) {
    console.error("usage: DISCORD_BOT_TOKEN=... MODS_CHANNEL_ID=... node scripts/post-mods-message.mjs [--edit <messageId> | --edit-current | --replace] [--dry-run]");
    process.exit(2);
  }
  let previous = [];
  if (editCurrent || replace) {
    const found = await findModsMessages(token, channelId, fetch);
    if (!found.ok) fail(`could not list the channel: ${found.detail}`);
    previous = found.ids;
    console.log(`found ${previous.length} existing button message(s)`);
    if (editCurrent && previous.length) messageId = previous[0];
  }
  const r = await postModsMessage(token, channelId, fetch, { messageId, dryRun });
  if (!r.ok) {
    console.error(`failed: HTTP ${r.status ?? "n/a"}${r.detail ? ` ${r.detail}` : ""}`);
    process.exit(1);
  }
  if (r.dryRun) console.log(`[dry-run] ${messageId ? "would PATCH" : "would POST"} the message (no request sent)`);
  else console.log(`${messageId ? "edited" : "posted"} message ${r.messageId}`);
  if (replace && previous.length) {
    if (dryRun) {
      console.log(`[dry-run] would delete ${previous.join(", ")}`);
      return;
    }
    const failed = await deleteMessages(token, channelId, previous, fetch);
    console.log(`deleted ${previous.length - failed.length} earlier message(s)`);
    if (failed.length) fail(`could not delete ${failed.join(", ")}`);
  }
}

// Run as a CLI, not when imported by the test suite.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
const invokedAsScript =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedAsScript) await main();
