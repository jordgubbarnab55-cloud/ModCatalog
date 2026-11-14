// Forum ingestion (Phase 1).
//
// A scheduled tick (every 5 minutes, wrangler cron) checks ONE dedicated
// forum channel for new mod posts. For each human-authored thread that
// contains a zip attached by the thread's own author, the bot posts a
// public, editable prompt with "Publish as-is" / "No thanks" buttons.
// On the owner's click — or 36 h after the prompt, automatically — the
// package is dispatched to the `ingest-forum` workflow, which downloads
// the package from the Discord CDN and feeds it into the existing
// inbox/pipeline. THIS WORKER DOES NO FILE TRANSFER; it only ever passes
// fresh signed CDN URLs (never stored) to the workflow.
//
// State lives in D1 (env.DB, `forum_posts`); the only KV key is the
// archived-thread pagination cursor. Quota reuses the /upload KV key
// (`quota:<discordId>`, bytes per UTC day).
//
// Security rules (all enforced here):
//   * only attachments from messages authored by thread.owner_id count;
//   * a button click is accepted only when clicker id == owner id;
//   * bot-authored threads are skipped;
//   * no signed URL is ever logged; the only URLs that leave this module
//     are fresh ones inside a workflow_dispatch input.

import { uploaderStamp } from "./index.js";

const DISCORD_API = "https://discord.com/api/v10";
const AUTO_AFTER_MS = 36 * 3600 * 1000;         // prompt_sent_at + 36 h
const PROMPT_STUCK_MS = 10 * 60 * 1000;        // stuck 'prompting' rows retry
const WATCHDOG_MS = 30 * 60 * 1000;            // processing -> unconfirmed
const TERMINAL_AFTER_MS = 48 * 3600 * 1000;    // terminal rows deleted
const AWAITING_PACKAGE_AFTER_MS = 36 * 3600 * 1000;
const MAX_THREADS_PER_TICK = 10;
const MAX_DISPATCH_ATTEMPTS = 3;
// Free-plan per-invocation caps (Cloudflare docs): 50 subrequests and 50
// D1 queries. The tick budgets itself and stops gracefully (the state
// machine is per-transition guarded, so the next tick picks up).
const D1_CAP = 50;
const SUB_CAP = 50;
const D1_PER_THREAD = 8;   // worst case per thread (conservative reservation)
const SUB_PER_THREAD = 7;
const ARCHIVED_CURSOR = "forum:archived_before"; // the one small KV key
const CATALOG_KEY = "forum:catalog";             // ETag + compact snapshot
const DEFAULT_DAILY_BYTES = 2147483648;

// ------------------------------------------------------------- D1 access
// One statement per transition; FakeD1 in the tests matches these.

export const FSQL = {
  insertRow: "INSERT OR IGNORE INTO forum_posts (thread_id, owner_id, owner_name, status, last_msg_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  getRow: "SELECT * FROM forum_posts WHERE thread_id = ?1",
  listStatus: "SELECT * FROM forum_posts WHERE status = ?1",
  deleteRow: "DELETE FROM forum_posts WHERE thread_id = ?1",
  setPrompted: "UPDATE forum_posts SET status = 'awaiting', prompt_msg = ?2, prompt_sent_at = ?3, auto_due = ?4, last_msg_id = ?5 WHERE thread_id = ?1 AND status = 'prompting'",
  packageAppeared: "UPDATE forum_posts SET status = 'prompting', last_msg_id = ?2 WHERE thread_id = ?1 AND status = 'awaiting_package'",
  startProcessing: "UPDATE forum_posts SET status = 'processing', dispatched_at = ?2, attempts = attempts + 1 WHERE thread_id = ?1 AND status = 'awaiting'",
  revertToAwaiting: "UPDATE forum_posts SET status = 'awaiting', dispatched_at = NULL WHERE thread_id = ?1 AND status = 'processing'",
  setDispatched: "UPDATE forum_posts SET pkg_size = ?2, detail = 'dispatched' WHERE thread_id = ?1 AND status = 'processing'",
  markDeclined: "UPDATE forum_posts SET status = 'declined' WHERE thread_id = ?1 AND status = 'awaiting'",
  markUnconfirmed: "UPDATE forum_posts SET status = 'unconfirmed' WHERE thread_id = ?1 AND status = 'processing'",
  markPublished: "UPDATE forum_posts SET status = 'published' WHERE thread_id = ?1 AND status IN ('processing', 'unconfirmed')",
  // pre-guard failures (quota, zip gone): only a row still in 'awaiting' is
  // ours to fail (a concurrent dispatch may have won the guard meanwhile)
  markFailed: "UPDATE forum_posts SET status = 'failed', detail = ?2 WHERE thread_id = ?1 AND status = 'awaiting'",
  // the ingest-stage failure callback: only rows in 'processing'
  markFailedProcessing: "UPDATE forum_posts SET status = 'failed', detail = ?2 WHERE thread_id = ?1 AND status = 'processing'",
  setUploaded: "UPDATE forum_posts SET pkg_sha256 = ?2, detail = 'uploaded' WHERE thread_id = ?1 AND status = 'processing'",
  touchLastMsg: "UPDATE forum_posts SET last_msg_id = ?2 WHERE thread_id = ?1",
  setIdentKey: "UPDATE forum_posts SET ident_key = ?2 WHERE thread_id = ?1 AND status = 'processing'",
  setPromptMsg: "UPDATE forum_posts SET prompt_msg = ?2 WHERE thread_id = ?1",
  cleanupTerminal: "DELETE FROM forum_posts WHERE status IN ('published', 'declined', 'failed') AND created_at < ?1",
  cleanupAwaitingPackage: "DELETE FROM forum_posts WHERE status = 'awaiting_package' AND created_at < ?1",
  cleanupUnconfirmed: "DELETE FROM forum_posts WHERE status = 'unconfirmed' AND created_at < ?1",
};

// Small D1 wrapper: `q(d1, name, ...args)` -> { row, rows, changes }
export async function q(d1, name, ...args) {
  const stmt = d1.prepare(FSQL[name]).bind(...args);
  if (name === "getRow") {
    const r = await stmt.first();
    return { row: r || null };
  }
  if (name === "listStatus") {
    const r = await stmt.all();
    return { rows: r.results || [] };
  }
  const r = await stmt.run();
  return { changes: (r.meta && r.meta.changes) || 0 };
}

function iso(d) { return d.toISOString(); }

// ------------------------------------------------------------ helpers

async function discord(env, fetchImpl, method, path, body) {
  const res = await fetchImpl(`${DISCORD_API}${path}`, {
    method,
    headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (res.status === 429) { const e = new Error("discord 429"); e.retryable = true; throw e; }
  if (res.status === 404) return null;
  if (!res.ok) { const e = new Error(`discord HTTP ${res.status}`); e.status = res.status; throw e; }
  if (res.status === 204) return null;
  return res.json();
}

// Fresh signed CDN URLs come from message fetches only (never stored).
// The thread objects (list and single) carry NO `owner` object (only
// owner_id) and `applied_tags` as raw ids, so the owner user and the
// guild's tag names are fetched separately.
async function ownerUser(env, fetchImpl, uid) {
  return discord(env, fetchImpl, "GET", `/users/${uid}`);
}

async function channelTagNames(env, fetchImpl) {
  // The forum channel object carries `available_tags` [{id, name, …}];
  // thread objects' `applied_tags` are raw ids (verified live). There is
  // no guild-level tag-list endpoint (it 404s).
  const c = await discord(env, fetchImpl, "GET", `/channels/${env.FORUM_CHANNEL_ID}`);
  const out = {};
  for (const t of (c && c.available_tags) || []) if (t && t.id && t.name) out[t.id] = t.name;
  return out;
}

// Budget wrapper: counts D1 statements (a batch = 1, matching the docs)
// and outbound subrequests; the tick checks it before each unit of work.
function budgetedD1(d1, budget) {
  const mk = (stmt) => ({
    run: async () => { budget.d1 += 1; return stmt.run(); },
    first: async () => { budget.d1 += 1; return stmt.first(); },
    all: async () => { budget.d1 += 1; return stmt.all(); },
    __raw: stmt,   // for d1.batch() (a batch = 1 query against the cap)
  });
  return {
    prepare: (sql) => ({ bind: (...a) => mk(d1.prepare(sql).bind(...a)) }),
    batch: async (stmts) => { budget.d1 += 1; return d1.batch(stmts.map((st) => st.__raw || st)); },
  };
}

function withinBudget(budget) {
  return budget.d1 + D1_PER_THREAD < D1_CAP && budget.sub + SUB_PER_THREAD < SUB_CAP;
}

function tagNamesOf(appliedTags, byId) {
  const out = [];
  for (const el of appliedTags || []) {
    const name = typeof el === "string" ? byId[el] : el && el.name;
    if (name) out.push(name);
  }
  return out;
}

// Fresh signed CDN URLs come from message fetches only (never stored).
function ownerZipAndCover(messages, ownerId) {
  let zip = null;                 // most recent owner-authored .zip
  let cover = null;              // first (oldest) owner-authored image
  const mimes = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };
  for (const m of messages) {
    if (!m || m.author?.id !== ownerId) continue;
    for (const a of m.attachments || []) {
      const name = a.filename || "";
      const lower = name.toLowerCase();
      if (lower.endsWith(".zip") && a.size > 0) zip = { url: a.url, filename: name, size: a.size };
      else if (cover == null && mimes[a.content_type] && a.size > 0) cover = { url: a.url, filename: name, mime: a.content_type };
    }
  }
  return { zip, cover };
}

// The daily byte quota, shared with /upload (same KV key + variable).
function quotaLimit(env) {
  const l = Number(env.UPLOAD_DAILY_BYTES);
  return l > 0 ? l : DEFAULT_DAILY_BYTES;
}
async function quotaUsed(env, uid, now) {
  const raw = await env.TOKENS.get(`quota:${uid}`);
  if (!raw) return 0;
  const q = JSON.parse(raw);
  return q.date === now.toISOString().slice(0, 10) ? (q.bytes || 0) : 0;
}
async function quotaSet(env, uid, bytes, now) {
  await env.TOKENS.put(`quota:${uid}`, JSON.stringify({ date: now.toISOString().slice(0, 10), bytes }));
}

// The prompt message text (public — the thread is public; no secrets here).
function promptText({ title, ownerName, zip, warning }) {
  const size = zip ? ` (~${Math.max(1, Math.round(zip.size / 1048576))} MB)` : "";
  return [
    `**📦 Publish this package as a mod?**`,
    `Title: **${title}**  •  Author: **${ownerName}** (verified)`,
    `Package: \`${zip ? zip.filename : "no zip yet"}\`${size}`,
    warning
      ? `\n> ⚠️ **A mod with this name already exists** — unless the thread is renamed, this upload will be rejected as a duplicate.`
      : "",
    `\nReply within 36 hours, or it will be **published automatically**.`,
  ].filter(Boolean).join("\n");
}

const BUTTONS = (tid) => [{
  type: 1,
  components: [
    { type: 2, style: 1, label: "Publish as-is", custom_id: `forum_publish:${tid}` },
    { type: 2, style: 2, label: "No thanks", custom_id: `forum_decline:${tid}` },
  ],
}];

async function postPrompt(env, fetchImpl, tid, text) {
  try {
    const msg = await discord(env, fetchImpl, "POST", `/channels/${tid}/messages`,
      { content: text, components: BUTTONS(tid) });
    return msg && msg.id ? msg.id : null;
  } catch (e) {
    if (e.retryable) throw e;
    return null; // stays 'prompting': retried on a later tick
  }
}

async function editPrompt(env, fetchImpl, d1, tid, msgId, content, { buttons = false } = {}) {
  if (!msgId) return;
  try {
    await discord(env, fetchImpl, "PATCH", `/channels/${tid}/messages/${msgId}`,
      { content, components: buttons ? BUTTONS(tid) : [] });
  } catch (e) {
    if (e.retryable) throw e;
    // Verified live: editing a message in an archived thread is a 400
    // (code 50083 "Thread is archived") while POSTING a new message in an
    // archived thread works — so fall back to a fresh message and point the
    // row at it (later updates edit THAT message; no message pile-up).
    if (e.status === 400 || e.status === 404) {
      try {
        const msg = await discord(env, fetchImpl, "POST", `/channels/${tid}/messages`,
          { content, components: buttons ? BUTTONS(tid) : [] });
        if (msg && msg.id) await q(d1, "setPromptMsg", tid, msg.id);
      } catch (e2) { if (e2.retryable) throw e2; }
    }
  }
}

const CATALOG_LINK = (env) => (env.CATALOG_URL || "").replace(/\/catalog\.json$/i, "") || "the catalog";

// ------------------------------------------------- catalog (ETag cache)

async function fetchCatalog(env, fetchImpl, now) {
  const cached = await env.TOKENS.get(CATALOG_KEY);
  let parsed = null;
  if (cached) {
    try { parsed = JSON.parse(cached); } catch { parsed = null; }
  }
  try {
    const res = await fetchImpl(env.CATALOG_URL, {
      headers: parsed ? { "If-None-Match": parsed.etag } : {}, // the value already carries its quotes
    });
    if (res.status === 304 && parsed) {
      return new Map(parsed.mods.map(([k, updated]) => [k, { updated }]));
    }
    if (res.ok) {
      const data = await res.json();
      const mods = (data.mods || []).filter((m) => m.id)
        .map((m) => [m.id.toLowerCase(), m.updated || ""]);
      const etag = res.headers.get("etag");
      if (etag) await env.TOKENS.put(CATALOG_KEY, JSON.stringify({ etag, mods, at: now.getTime() }));
      return new Map(mods.map(([k, updated]) => [k, { updated }]));
    }
  } catch { /* network: fall back to the cache */ }
  if (parsed) return new Map(parsed.mods.map(([k, updated]) => [k, { updated }]));
  return new Map();
}

// ------------------------------------------------------------- the tick

export async function forumTick(env, fetchImpl, now = new Date()) {
  const out = { skipped: false, candidates: 0, prompts: 0, dispatches: 0,
    published: 0, unconfirmed: 0, deleted: 0, backoff: false, stopped: false };
  if (!env.FORUM_GUILD_ID || !env.FORUM_CHANNEL_ID || !env.DB) return { ...out, skipped: true };
  const d1 = env.DB;
  const cutoff = BigInt(env.FORUM_CUTOFF_THREAD_ID || "0");
  let tagMap = {};
  try { tagMap = JSON.parse(env.FORUM_TAG_MAP || "{}"); } catch { tagMap = {}; }

  // 1. enumerate: guild-wide active threads + archived since last page.
  const threads = new Map();
  let active;
  try {
    active = await discord(env, fetchImpl, "GET", `/guilds/${env.FORUM_GUILD_ID}/threads/active`);
  } catch (e) { if (e.retryable) { out.backoff = true; return out; } throw e; }
  for (const t of (active && active.threads) || []) {
    if (t.parent_id === env.FORUM_CHANNEL_ID) threads.set(t.id, t);
  }
  const cursor = await env.TOKENS.get(ARCHIVED_CURSOR);
  let before = cursor;
  if (!before && env.FORUM_CUTOFF_THREAD_ID)
    // the endpoint's `before` is an ISO8601 timestamp, not a snowflake:
    before = new Date(Number((BigInt(env.FORUM_CUTOFF_THREAD_ID) >> 22n) + 1420070400000n)).toISOString();
  if (before) {
    let archived;
    try {
      archived = await discord(env, fetchImpl, "GET",
        `/channels/${env.FORUM_CHANNEL_ID}/threads/archived/public?before=${encodeURIComponent(before)}&limit=100`);
    } catch (e) { if (e.retryable) { out.backoff = true; return out; } throw e; }
    const list = (archived && archived.threads) || [];
    for (const t of list) if (t.parent_id === env.FORUM_CHANNEL_ID) threads.set(t.id, t);
    if (archived && archived.has_more && list.length) {
      const last = list[list.length - 1];
      const tm = last.thread_metadata || {};
      // the pagination cursor is the last thread's archive timestamp
      await env.TOKENS.put(ARCHIVED_CURSOR, tm.archive_timestamp || tm.create_timestamp);
    } else if (cursor) {
      await env.TOKENS.delete(ARCHIVED_CURSOR);
    }
  }

  // 2. candidates: above the cutoff, chronological (oldest) order. The
  // 10-slot cap is applied in the loop to the threads that NEED work —
  // unchanged threads are skipped first (one cheap D1 read each), so a
  // pile of zip-less `awaiting_package` threads cannot starve new posts.
  const cands = [...threads.values()]
    .filter((t) => t && t.owner_id && BigInt(t.id) > cutoff)
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  out.candidates = cands.length;

  // 3. per-thread state machine, budgeted against the free-plan caps
  // (50 subrequests / 50 D1 queries per invocation). When the budget runs
  // out — or D1 enforces its cap — the tick stops cleanly; the guarded
  // transitions make the next tick a safe continuation.
  const budget = { d1: 0, sub: 0 };
  const d1b = budgetedD1(d1, budget);
  const f = (url, init) => { budget.sub += 1; return fetchImpl(url, init); };
  const capErr = (e) => /too many/i.test(String((e || {}).message));
  let catalog = null;
  const catalogFor = async () => { if (!catalog) catalog = await fetchCatalog(env, f, now); return catalog; };
  let processed = 0;
  for (const t of cands) {
    let row = null;
    try {
      row = (await q(d1b, "getRow", t.id)).row;
    } catch (e) {
      if (e.retryable) { out.backoff = true; return out; }
      if (capErr(e)) { out.stopped = true; break; }
      throw e;
    }
    const msgChanged = row ? (t.last_message_id != null && t.last_message_id !== row.last_msg_id) : true;
    const autoDue = !!(row && row.status === "awaiting" && row.auto_due &&
                       now.getTime() >= Date.parse(row.auto_due));
    const stuck = !!(row && row.status === "prompting" && !row.prompt_msg &&
                     now.getTime() - Date.parse(row.created_at) > PROMPT_STUCK_MS);
    if (row && !msgChanged && !autoDue && !stuck) {
      // unchanged: still probe thread deletion (one cheap thread-object
      // fetch; 404 when the post was deleted) so such rows get cleaned
      let tobj;
      try { tobj = await discord(env, f, "GET", `/channels/${t.id}`); }
      catch (e) {
        if (e.retryable) { out.backoff = true; return out; }
        if (capErr(e)) { out.stopped = true; break; }
        throw e;
      }
      if (tobj === null && (await q(d1b, "deleteRow", t.id)).changes) out.deleted++;
      continue;
    }
    if (row && (row.status === "published" || row.status === "declined" ||
                row.status === "failed")) {
      // terminal: a cheap touch at most (no subrequests, no cap slot)
      if (msgChanged) {
        try { await q(d1b, "touchLastMsg", t.id, t.last_message_id); }
        catch (e) {
          if (e.retryable) { out.backoff = true; return out; }
          if (capErr(e)) { out.stopped = true; break; }
          throw e;
        }
      }
      continue;
    }
    if (processed >= MAX_THREADS_PER_TICK) { out.stopped = true; break; }
    if (!withinBudget(budget)) { out.stopped = true; break; }
    processed++;
    try {
      if (!msgChanged && autoDue) {
        // unchanged but due: straight to the dispatch (it re-fetches fresh
        // URLs / the owner user / the messages itself)
        const r = await startDispatch(env, f, d1b, row, now);
        if (r === "dispatched") out.dispatches++;
      } else {
        await processThread(env, f, d1b, t, row, tagMap, now, catalogFor, out);
      }
    } catch (e) {
      if (e.retryable) { out.backoff = true; return out; }
      if (capErr(e)) { out.stopped = true; break; }
      throw e;
    }
  }

  // 4. reconcile processing/unconfirmed rows against the catalog.
  let pending = [];
  try {
    pending = [
      ...(await q(d1b, "listStatus", "processing")).rows,
      ...(await q(d1b, "listStatus", "unconfirmed")).rows,
    ];
  } catch (e) {
    if (e.retryable) { out.backoff = true; return out; }
    if (!capErr(e)) throw e;
    out.stopped = true;
  }
  if (pending.length) {
    const cat = await catalogFor();
    for (const row of pending) {
      if (!withinBudget(budget)) { out.stopped = true; break; }
      const entry = row.ident_key ? cat.get(row.ident_key) : null;
      if (entry && row.dispatched_at && Date.parse(entry.updated) >= Date.parse(row.dispatched_at)) {
        if ((await q(d1b, "markPublished", row.thread_id)).changes) {
          out.published++;
          await editPrompt(env, f, d1b, row.thread_id, row.prompt_msg,
            `✅ **Published** — *${row.owner_name}*\'s package is in the catalog. ${CATALOG_LINK(env)}`);
        }
      } else if (row.status === "processing" &&
                 now.getTime() - Date.parse(row.dispatched_at) > WATCHDOG_MS) {
        if ((await q(d1b, "markUnconfirmed", row.thread_id)).changes) {
          out.unconfirmed++;
          await editPrompt(env, f, d1b, row.thread_id, row.prompt_msg,
            `⚠️ **No confirmation yet** — the package was sent to the pipeline, but the ` +
            `catalog has not confirmed it (it may have been rejected, e.g. as a duplicate ` +
            `of an existing mod). We keep watching for 48 h; check this thread if it ` +
            `doesn't appear.`);
        }
      }
    }
  }

  // 5. cleanup: awaiting_package > 36 h; terminal rows > 48 h; unconfirmed > 48 h.
  // Three independent DELETEs in one batch = ONE D1 query against the cap.
  const cut = new Date(now.getTime() - AWAITING_PACKAGE_AFTER_MS).toISOString();
  const cut48 = new Date(now.getTime() - TERMINAL_AFTER_MS).toISOString();
  try {
    const res = await d1b.batch([
      d1b.prepare(FSQL.cleanupAwaitingPackage).bind(cut),
      d1b.prepare(FSQL.cleanupTerminal).bind(cut48),
      d1b.prepare(FSQL.cleanupUnconfirmed).bind(cut48),
    ]);
    for (const r of res || []) out.deleted += (r.meta && r.meta.changes) || 0;
  } catch (e) {
    if (e.retryable) { out.backoff = true; return out; }
    if (!capErr(e)) throw e;
    out.stopped = true;
  }
  return out;
}

async function processThread(env, fetchImpl, d1, t, row, tagMap, now, catalogFor, out) {
  const tid = t.id;
  // The owner (fresh username + the bot flag; the thread objects carry
  // no owner object).
  const owner = await ownerUser(env, fetchImpl, t.owner_id);
  if (!owner || owner.bot) return; // bot-authored threads are skipped
  const ownerName = owner.username || "";

  // Fresh messages (also the 404 = thread-deleted detection).
  const msgs = await discord(env, fetchImpl, "GET", `/channels/${tid}/messages?limit=50`);
  if (msgs === null) {                       // 404: the post was deleted
    if (row) {
      await q(d1, "deleteRow", tid);
      out.deleted++;
    }
    return;
  }
  const list = Array.isArray(msgs) ? msgs : (msgs.messages || []);
  const lastMsgId = list.length ? list[list.length - 1].id : (t.last_message_id || null);
  const { zip } = ownerZipAndCover(list, t.owner_id);

  if (!row) {
    if (!t.name || !t.name.trim()) return;  // an all-whitespace title can't mint
    if (!zip) {
      await q(d1, "insertRow", tid, t.owner_id, ownerName, "awaiting_package", lastMsgId, iso(now));
      return;
    }
    const ok = await q(d1, "insertRow", tid, t.owner_id, ownerName, "prompting", lastMsgId, iso(now));
    if (!ok.changes) return;               // INSERT OR IGNORE lost a race: the other tick prompts
    await promptAndAwait(env, fetchImpl, d1, t, ownerName, zip, lastMsgId, tagMap, catalogFor, now, out);
    return;
  }

  if (row.status === "awaiting_package") {
    if (zip && lastMsgId !== row.last_msg_id) {
      if (!(await q(d1, "packageAppeared", tid, lastMsgId)).changes) return; // lost a race
      await promptAndAwait(env, fetchImpl, d1, t, ownerName, zip, lastMsgId, tagMap, catalogFor, now, out);
    } else if (lastMsgId !== row.last_msg_id) {
      await q(d1, "touchLastMsg", tid, lastMsgId);
    }
    return;
  }
  if (row.status === "prompting" && !row.prompt_msg &&
      now.getTime() - Date.parse(row.created_at) > PROMPT_STUCK_MS) {
    // The prompt post failed earlier: retry.
    await promptAndAwait(env, fetchImpl, d1, t, ownerName, zip, lastMsgId, tagMap, catalogFor, now, out);
    return;
  }
  if (lastMsgId !== row.last_msg_id) await q(d1, "touchLastMsg", tid, lastMsgId);

  // 36 h auto-publish, anchored to the prompt time.
  if (row.status === "awaiting" && row.auto_due &&
      now.getTime() >= Date.parse(row.auto_due)) {
    const r = await startDispatch(env, fetchImpl, d1, row, now);
    if (r === "dispatched") out.dispatches++;
  }
}

async function promptAndAwait(env, fetchImpl, d1, t, ownerName, zip, lastMsgId, tagMap, catalogFor, now, out) {
  let warning = false;
  try {
    const title = t.name.replace(/\s+/g, "");
    const identKey = `${t.owner_id}.${title}`.toLowerCase();
    warning = (await catalogFor()).has(identKey);
  } catch { warning = false; }
  const msgId = await postPrompt(env, fetchImpl, t.id,
    promptText({ title: t.name, ownerName, zip, warning }));
  if (!msgId) return;                       // stays 'prompting': retried next tick(s)
  const sentAt = iso(now);
  const autoDue = iso(new Date(now.getTime() + AUTO_AFTER_MS));
  if ((await q(d1, "setPrompted", t.id, msgId, sentAt, autoDue, lastMsgId)).changes) out.prompts++;
}

// ------------------------------------------------------ the dispatch

// Shared by the click path and the 36 h auto path. Returns "dispatched",
// "already" (another path won the race) or "failed:<reason>".
export async function startDispatch(env, fetchImpl, d1, row, now) {
  const tid = row.thread_id;
  // 1. fresh thread + messages (fresh signed CDN URLs, never stored).
  let t;
  try { t = await discord(env, fetchImpl, "GET", `/channels/${tid}`); } catch (e) {
    if (!e.retryable) return "failed:thread gone";
    throw e;
  }
  if (t === null) {
    // the post was deleted: the prompt is gone with it — drop the row
    if ((await q(d1, "deleteRow", tid)).changes) return "deleted";
    return "failed:thread gone";
  }
  if (t.parent_id !== env.FORUM_CHANNEL_ID) return "failed:not in the forum channel";
  const owner = await ownerUser(env, fetchImpl, row.owner_id);
  if (!owner || owner.bot) return failDispatch(env, fetchImpl, d1, row, "the thread is no longer usable");
  const ownerName = owner.username || row.owner_name;
  const msgs = await discord(env, fetchImpl, "GET", `/channels/${tid}/messages?limit=50`);
  const list = Array.isArray(msgs) ? msgs : (msgs && msgs.messages) || [];
  const { zip, cover } = ownerZipAndCover(list, t.owner_id);
  if (!zip) return failDispatch(env, fetchImpl, d1, row, "the package is no longer attached to the thread");

  // 2. quota (checked before the race guard; charged only after winning it).
  const used = await quotaUsed(env, row.owner_id, now);
  if (used + zip.size > quotaLimit(env)) {
    return failDispatch(env, fetchImpl, d1, row,
      "daily upload limit reached; repost or ask a moderator");
  }
  // 3. retry cap.
  if (row.attempts >= MAX_DISPATCH_ATTEMPTS) {
    return failDispatch(env, fetchImpl, d1, row, "dispatch failed 3 times; ask a moderator");
  }
  // 4. the awaiting -> processing race guard (exactly one dispatch per thread).
  if (!(await q(d1, "startProcessing", tid, iso(now))).changes) {
    const cur = (await q(d1, "getRow", tid)).row;
    if (cur && cur.status === "processing") return "already";
    return "failed:state moved";
  }
  // 5. build the small workflow payload (fresh URLs only).
  // Description = the FIRST (oldest) owner message's content (the post itself).
  let tagMap = {};
  try { tagMap = JSON.parse(env.FORUM_TAG_MAP || "{}"); } catch { tagMap = {}; }
  const firstOwnerMsg = list.find((m) => m.author?.id === t.owner_id && m.content);
  const byTagId = await channelTagNames(env, fetchImpl); // a 429 propagates (back off)
  const tagNames = tagNamesOf(t.applied_tags, byTagId);
  const metadata = {
    title: t.name,
    description: (firstOwnerMsg && firstOwnerMsg.content || "").slice(0, 16384),
    version: "",
    game_version: "",
    author: ownerName,
    tags: tagNames.map((n) => tagMap[n] ?? n),
  };
  const inputs = {
    thread_id: tid,
    upload_id: `forum-${tid}`,           // derived from the thread id (idempotent retries)
    stamp: uploaderStamp(row.owner_id, ownerName),
    package_url: zip.url,
    package_name: zip.filename,
    package_size: String(zip.size),
    cover_url: cover ? cover.url : "",
    cover_name: cover ? cover.filename : "",
    cover_mime: cover ? cover.mime : "",
    metadata: JSON.stringify(metadata),
  };
  let dispatch;
  try {
    dispatch = await fetchImpl(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
      `/actions/workflows/ingest-forum.yml/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": "ModCatalog-Worker",
        },
        body: JSON.stringify({ ref: "main", inputs }),
      });
  } catch { dispatch = null; }
  if (!dispatch || (!dispatch.ok && dispatch.status !== 204)) {
    // Our side: revert and let the next tick (or the owner's click) retry.
    if ((await q(d1, "revertToAwaiting", tid)).changes) {
      const cur = (await q(d1, "getRow", tid)).row;
      const exhausted = cur && cur.attempts >= MAX_DISPATCH_ATTEMPTS;
      if (exhausted) {
        await q(d1, "markFailed", tid, "dispatch failed 3 times");
        await editPrompt(env, fetchImpl, d1, tid, row.prompt_msg,
          "❌ **Couldn't publish:** the pipeline dispatch failed 3 times; ask a moderator");
      } else {
        await editPrompt(env, fetchImpl, d1, tid, row.prompt_msg,
          "↻ The pipeline dispatch failed; it will be retried automatically.",
          { buttons: true });
      }
    }
    return "failed:dispatch failed";
  }
  // 6. won: charge the quota, record the size (for refunds), update the prompt.
  await quotaSet(env, row.owner_id, used + zip.size, now);
  await q(d1, "setDispatched", tid, zip.size);
  // compute the identifier we will reconcile on (from the title used NOW).
  const identKey = `${row.owner_id}.${t.name.replace(/\s+/g, "")}`.toLowerCase();
  await q(d1, "setIdentKey", tid, identKey);
  await editPrompt(env, fetchImpl, d1, tid, row.prompt_msg,
    `⏳ **Processing…** *${t.name}* is on its way to the catalog. ${CATALOG_LINK(env)}`);
  return "dispatched";
}

async function failDispatch(env, fetchImpl, d1, row, reason) {
  if ((await q(d1, "markFailed", row.thread_id, reason.slice(0, 300))).changes) {
    await editPrompt(env, fetchImpl, d1, row.thread_id, row.prompt_msg,
      `❌ **Couldn't publish:** ${reason}`);
  }
  return `failed:${reason}`;
}

// ------------------------------------------------- the button clicks

// The /discord handler calls this AFTER sending the 202 ACK (+ defer
// callback), so the heavy work happens outside Discord's 3 s window.
// Returns a reply object for a late/foreign click, or null (the prompt
// itself carries the outcome).
export async function handleForumClick(env, fetchImpl, d1, { customId, clickerId }, now = new Date()) {
  const i = String(customId || "").indexOf(":");
  const kind = i > 0 ? customId.slice(0, i) : "";
  const tid = i > 0 ? customId.slice(i + 1) : "";
  if (!/^\d{1,32}$/.test(tid)) return { content: "This prompt is no longer active.", flags: 64 };
  const { row } = await q(d1, "getRow", tid);
  if (!row) return { content: "This prompt is no longer active.", flags: 64 };
  if (clickerId !== row.owner_id) {
    return { content: "Only the thread's author can respond to this prompt.", flags: 64 };
  }
  if (kind === "forum_decline") {
    if ((await q(d1, "markDeclined", tid)).changes) {
      await editPrompt(env, fetchImpl, d1, tid, row.prompt_msg,
        "👌 Declined — nothing was published.");
      return null;
    }
    const cur = (await q(d1, "getRow", tid)).row;
    return { content: lateClickText(cur), flags: 64 };
  }
  if (kind === "forum_publish") {
    if (row.status !== "awaiting") return { content: lateClickText(row), flags: 64 };
    const r = await startDispatch(env, fetchImpl, d1, row, now);
    if (r === "already") return { content: "Already processing — check the prompt.", flags: 64 };
    if (r.startsWith("failed:") && r !== "failed:dispatch failed") {
      // A hard failure edited the prompt itself; no extra reply needed.
      return null;
    }
    return null;
  }
  return { content: "This prompt is no longer active.", flags: 64 };
}

function lateClickText(row) {
  if (!row) return "This prompt is no longer active.";
  if (row.status === "processing" || row.status === "unconfirmed") return "Already processing — check the prompt.";
  if (row.status === "published") return "Already published.";
  if (row.status === "declined") return "Already declined.";
  if (row.status === "failed") return "This upload already failed; see the prompt.";
  return "This prompt is no longer active.";
}

// ----------------------------------------------- the status callback

// HMAC-SHA256 of the raw body, hex, constant-time compared. Only rows in
// `processing` are acted on.
export async function handleForumStatus(request, env, fetchImpl, now = new Date()) {
  if (request.method !== "POST") return new Response("POST only", { status: 405 });
  const raw = await request.text();
  const sig = (request.headers.get("X-Forum-Signature") || "").trim();
  if (!(await hmacMatches(env.FORUM_CALLBACK_SECRET, raw, sig))) {
    return new Response("bad signature", { status: 401 });
  }
  let body;
  try { body = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  // Replay protection: the timestamp is part of the signed payload and
  // must be recent (10 min absorbs runner/CF clock skew).
  const ts = Number(body.ts);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 600) {
    return new Response("stale callback", { status: 400 });
  }
  const tid = String(body.thread_id || "");
  if (!/^\d{1,32}$/.test(tid)) return new Response("bad thread_id", { status: 400 });
  if (body.status !== "uploaded" && body.status !== "failed") return new Response("bad status", { status: 400 });
  const { row } = await q(env.DB, "getRow", tid);
  if (!row || row.status !== "processing") return new Response(null, { status: 204 });
  if (body.status === "uploaded") {
    const sha = String(body.pkg_sha256 || "").toLowerCase();
    if (/^[0-9a-f]{64}$/.test(sha)) await q(env.DB, "setUploaded", tid, sha);
  } else {
    const reason = String(body.reason || "the ingest failed").slice(0, 300);
    if ((await q(env.DB, "markFailedProcessing", tid, reason)).changes) {
      await refundQuota(env, row.owner_id, row.pkg_size, now);
      await editPrompt(env, fetchImpl, env.DB, tid, row.prompt_msg,
        `❌ **Couldn't publish:** ${reason}`);
    }
  }
  return new Response(null, { status: 204 });
}

async function refundQuota(env, uid, bytes, now) {
  if (!bytes) return;
  const used = await quotaUsed(env, uid, now);
  if (used > 0) await quotaSet(env, uid, Math.max(0, used - bytes), now);
}

async function hmacMatches(secret, raw, sigHex) {
  if (!secret || !sigHex) return false;
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
    const calc = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    const a = calc.toLowerCase(), b = sigHex.toLowerCase();
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  } catch { return false; }
}
