// Discord bot API client (zero dependencies, injectable fetch).
//
// One helper per call the mirror needs: `botFetch` (the Authorization
// header, JSON handling, ONE retry honouring a 429 `retry_after` with
// the wait capped at 5 s), `createForumThread` and `postMessage`.
// Every outgoing payload sets `allowed_mentions` explicitly (callers
// pass it), so user-supplied text can never ping @everyone/roles.

const DISCORD_API = "https://discord.com/api/v10";
const RETRY_AFTER_CAP_MS = 5000;

// The bot call: JSON in/out. A 429 is retried once after waiting
// `retry_after` (or `retry_after_ms`), capped at 5 s; a second 429
// throws with `.retryable` (the caller marks the event failed). A 404
// returns null (caller detects deleted threads); any other non-ok
// throws with `.status`.
async function botFetch(env, fetchImpl, method, path, body) {
  const attempt = async () => fetchImpl(`${DISCORD_API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body == null ? undefined : JSON.stringify(body),
  });
  let res = await attempt();
  if (res.status === 429) {
    let waitMs = 0;
    try {
      const data = await res.json().catch(() => null) || {};
      const ms = Number(data.retry_after_ms);
      const s = Number(data.retry_after);
      waitMs = Number.isFinite(ms) && ms > 0 ? ms : (Number.isFinite(s) && s > 0 ? s * 1000 : 0);
    } catch { waitMs = 0; }
    await new Promise((r) => setTimeout(r, Math.min(waitMs, RETRY_AFTER_CAP_MS)));
    res = await attempt();
    if (res.status === 429) {
      const e = new Error("discord 429"); e.retryable = true; throw e;
    }
  }
  if (res.status === 404) return null;
  if (!res.ok) {
    const e = new Error(`discord HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  if (res.status === 204) return null;
  return res.json();
}

// POST /channels/{FORUM_CHANNEL_ID}/threads — a new public forum post.
// {name (<=100), message: {content (<=2000), embeds, allowed_mentions},
// applied_tags: [ids]} -> the thread object (id).
export function createForumThread(env, fetchImpl, { name, content, embeds = [], tagIds = [], userIds = [] }) {
  return botFetch(env, fetchImpl, "POST", `/channels/${env.FORUM_CHANNEL_ID}/threads`, {
    name,
    message: {
      content,
      embeds,
      allowed_mentions: { parse: [], users: userIds },
    },
    applied_tags: tagIds,
  });
}

// POST /channels/{channelId}/messages -> the message object (id).
// The payload is caller-built (allowed_mentions included by the caller).
export function postMessage(env, fetchImpl, channelId, payload) {
  return botFetch(env, fetchImpl, "POST", `/channels/${channelId}/messages`, payload);
}
