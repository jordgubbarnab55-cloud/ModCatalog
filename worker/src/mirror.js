// Catalog outcome-event mirror (POST /catalog/events).
//
// The `process-inbox` / `rebuild` runner POSTs signed outcome events
// (Plan 4; build.py `notify`): X-Catalog-Signature = the hex
// HMAC-SHA256 of the raw body keyed with CATALOG_CALLBACK_SECRET, plus
// a fresh `ts` in the (signed) payload. For every event we mirror it
// into Discord:
//   * published -> one forum thread per mod (mod_threads row, keyed on
//     the lowercased identifier); a new thread on first sight, a new
//     message in the existing thread on updates (a thread deleted on
//     Discord 404/403 is re-created and the row replaced);
//   * rejected  -> a notice in NOTICES_CHANNEL_ID when set (else a log
//     line only; no DMs).
// A mirrored eventId goes into seen_events (idempotent retries; rows
// are swept 30 days old, opportunistically, on each request). One
// failing event never aborts the others; it stays unrecorded and is
// marked failed in the response so the runner can retry it.
//
// Subrequests per event are small (<= 3); with <= 10 events per
// request this stays inside the free-plan cap of 50 subrequests.

import { createForumThread, postMessage } from "./discord.js";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_EVENTS = 10;
const STALE_TS_S = 300;           // |now - ts| beyond this is a 401
const SEEN_SWEEP_MS = 30 * 24 * 3600 * 1000; // seen_events live 30 days
const MAX_TAG_IDS = 5;            // Discord's applied_tags cap

// One statement per transition; FakeD1 in the tests matches these.
export const MSQL = {
  seenGet: "SELECT * FROM seen_events WHERE event_id = ?1",
  seenInsert: "INSERT OR IGNORE INTO seen_events (event_id, created_at) VALUES (?1, ?2)",
  seenSweep: "DELETE FROM seen_events WHERE created_at < ?1",
  threadGet: "SELECT * FROM mod_threads WHERE mod_key = ?1",
  threadSet: "INSERT OR REPLACE INTO mod_threads (mod_key, thread_id, created_at) VALUES (?1, ?2, ?3)",
};

async function q(d1, name, ...args) {
  const stmt = d1.prepare(MSQL[name]).bind(...args);
  if (name === "seenGet" || name === "threadGet") {
    const r = await stmt.first();
    return { row: r || null };
  }
  const r = await stmt.run();
  return { changes: (r.meta && r.meta.changes) || 0 };
}

async function hmacMatches(secret, raw, sigHex) {
  if (!secret || !sigHex) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
    const calc = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    const a = calc.toLowerCase(), b = sigHex.toLowerCase().trim();
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}

// User-supplied text: truncated, backticks stripped (no code-block
// injection) and `@` neutralised (a bare `@` — and with
// allowed_mentions.parse = [] — can never start a mention, but the
// neutralisation keeps even the text from looking like one).
function clean(text, max) {
  return String(text ?? "").replace(/[`@]/g, "").slice(0, max);
}

// The catalog tags through FORUM_TAG_IDS (JSON object catalog-tag ->
// forum tag id; unknown tags ignored; max 5).
function forumTagIds(env, tags) {
  let map = {};
  try { map = JSON.parse(env.FORUM_TAG_IDS || "{}"); } catch { map = {}; }
  const out = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    const id = map[t];
    if (id != null) { const s = String(id); if (!out.includes(s)) out.push(s); }
    if (out.length >= MAX_TAG_IDS) break;
  }
  return out;
}

// The shared cover embed: the footer makes the thread identifiable
// (`mod-id: <identifier>`); the image is the cover when set.
function coverEmbed(coverUrl, identifier) {
  const embed = { footer: { text: `mod-id: ${clean(identifier, 2040)}` } };
  if (coverUrl) embed.image = { url: coverUrl };
  return embed;
}

const MENTION = (uid) => `<@${uid}>`;   // uid comes from the SIGNED event

// The first (thread-creating) message: "<@uid> published **title**
// vVERSION" + the (cleaned) description + a link to the site.
function publishContent(ev, env) {
  const lines = [
    `${MENTION(ev.uploaderId)} published **${clean(ev.title, 200)}** v${clean(ev.version, 50)}`,
  ];
  if (ev.description) lines.push(clean(ev.description, 500));
  lines.push(env.SITE_URL || "");
  return lines.filter(Boolean).join("\n").slice(0, 2000);
}

// A follow-up message in the mod's existing thread.
function updateContent(ev) {
  const lines = [`${MENTION(ev.uploaderId)} uploaded **v${clean(ev.version, 50)}**`];
  if (ev.description) lines.push(clean(ev.description, 500));
  return lines.join("\n").slice(0, 2000);
}

async function saveSeen(d1, eventId, nowIso) {
  await q(d1, "seenInsert", eventId, nowIso);
}

// Create the mod's forum thread (or replace a deleted one). Throws on
// Discord failure; returns the thread id.
async function createThread(env, fetchImpl, ev, nowIso) {
  const t = await createForumThread(env, fetchImpl, {
    name: clean(ev.title, 100) || "Untitled mod",
    content: publishContent(ev, env),
    embeds: [coverEmbed(ev.coverUrl, ev.identifier)],
    tagIds: forumTagIds(env, ev.tags),
    userIds: [ev.uploaderId],
  });
  const threadId = t && t.id ? String(t.id) : null;
  if (!threadId) throw new Error("discord thread create returned no id");
  console.log(`mirror: created forum thread ${threadId} for ${ev.identifier}`);
  await q(env.DB, "threadSet", String(ev.identifier).toLowerCase(), threadId, nowIso);
  return threadId;
}

// Post into the mod's existing thread; a 404/403 (the thread was
// deleted, or the bot lost permission there) re-creates it and
// replaces the mapping. Returns "posted" or "created".
async function postInThread(env, fetchImpl, ev, row, nowIso) {
  const payload = {
    content: updateContent(ev),
    embeds: [coverEmbed(ev.coverUrl, ev.identifier)],
    allowed_mentions: { parse: [], users: [ev.uploaderId] },
  };
  try {
    const m = await postMessage(env, fetchImpl, row.thread_id, payload);
    if (m === null) throw Object.assign(new Error("thread gone"), { status: 404 });
    return "posted";
  } catch (e) {
    if (e.status !== 404 && e.status !== 403) throw e;
  }
  await createThread(env, fetchImpl, ev, nowIso);
  return "created";
}

// The rejection notice (a plain text-channel message; user-only
// mention). Returns "posted" or "logged" (NOTICES_CHANNEL_ID unset).
async function postRejection(env, fetchImpl, ev) {
  if (!env.NOTICES_CHANNEL_ID) {
    console.log(`mirror: rejected ${ev.eventId} (${ev.uploaderName || ev.uploaderId}): ${ev.reason || "no reason"}`);
    return "logged";
  }
  const title = ev.title ? clean(ev.title, 200) : "unknown";
  const reason = clean(ev.reason || "no reason", 300);
  await postMessage(env, fetchImpl, env.NOTICES_CHANNEL_ID, {
    content: `${MENTION(ev.uploaderId)} your upload of **${title}** was not accepted: ${reason}`.slice(0, 2000),
    allowed_mentions: { parse: [], users: [ev.uploaderId] },
  });
  return "posted";
}

function badEvent(e) {
  if (typeof e !== "object" || e === null || Array.isArray(e)) return "event is not an object";
  if (typeof e.eventId !== "string" || !e.eventId) return "event needs an eventId";
  if (e.status !== "published" && e.status !== "rejected") return "event status is bad";
  if (e.mode !== "new" && e.mode !== "update" && e.mode !== null) return "event mode is bad";
  if (typeof e.uploaderId !== "string" || !e.uploaderId) return "event needs an uploaderId";
  if (e.status === "published") {
    if (typeof e.title !== "string" || !e.title.trim()) return "published event needs a title";
    if (typeof e.identifier !== "string" || !e.identifier) return "published event needs an identifier";
  }
  return null;
}

/**
 * POST /catalog/events. 200 {results:[{eventId, ok, skipped?, error?}]}.
 * `now` is injectable (the stale-`ts` check).
 */
export async function handleCatalogEvents(request, env, fetchImpl, now = new Date()) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return new Response("body too large", { status: 400 });
  if (!(await hmacMatches(env.CATALOG_CALLBACK_SECRET, raw, request.headers.get("X-Catalog-Signature") || ""))) {
    return new Response("bad signature", { status: 401 });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const ts = Number(body && body.ts);
  if (!Number.isFinite(ts) || Math.abs(now.getTime() / 1000 - ts) > STALE_TS_S) {
    return new Response("stale timestamp", { status: 401 });
  }
  const events = body && Array.isArray(body.events) ? body.events : null;
  if (!events || events.length === 0) return new Response("no events", { status: 400 });
  if (events.length > MAX_EVENTS) return new Response(`too many events (max ${MAX_EVENTS})`, { status: 400 });
  for (const e of events) {
    const bad = badEvent(e);
    if (bad) return new Response(bad, { status: 400 });
  }
  if (!env.DB) return new Response("database not configured", { status: 503 });

  // Opportunistic sweep: seen rows older than 30 days.
  const cut = new Date(now.getTime() - SEEN_SWEEP_MS).toISOString();
  await q(env.DB, "seenSweep", cut);

  const nowIso = now.toISOString();
  const results = [];
  for (const ev of events) {
    const out = { eventId: ev.eventId, ok: false };
    try {
      if ((await q(env.DB, "seenGet", ev.eventId)).row) {
        out.skipped = true; out.ok = true;
        results.push(out); continue;
      }
      if (ev.status === "published") {
        const row = (await q(env.DB, "threadGet", String(ev.identifier).toLowerCase())).row;
        if (!row) {
          await createThread(env, fetchImpl, ev, nowIso);
        } else {
          await postInThread(env, fetchImpl, ev, row, nowIso);
        }
      } else {
        await postRejection(env, fetchImpl, ev);
      }
      await saveSeen(env.DB, ev.eventId, nowIso);
      out.ok = true;
    } catch (e) {
      out.error = String((e && e.message) || e).slice(0, 200);
      console.error(`mirror: event ${ev.eventId} failed: ${out.error}`);
    }
    results.push(out);
  }
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
