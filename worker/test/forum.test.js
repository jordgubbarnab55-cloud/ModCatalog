// Offline tests for the forum ingestion (node --test, Node 20+).
//
// Fake D1 (with transition semantics + changed-row counts), Fake KV,
// injected fetch (records calls), and a generated Ed25519 keypair.
// Nothing touches the network.

import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { forumTick, handleForumClick, handleForumStatus, FSQL } from "../src/forum.js";

// ------------------------------------------------------------- fakes

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
}

// A fake D1 that implements exactly the forum statements (FSQL) with
// SQLite-like transition semantics; run() reports meta.changes.
class FakeD1 {
  constructor() { this.rows = new Map(); }
  row(tid) { return this.rows.get(tid) || null; }
  insert(tid, owner_id, owner_name, status, last_msg_id, created_at) {
    if (this.rows.has(tid)) return 0;
    this.rows.set(tid, {
      thread_id: tid, owner_id, owner_name, status,
      prompt_msg: null, last_msg_id, created_at,
      prompt_sent_at: null, auto_due: null, dispatched_at: null,
      attempts: 0, detail: null, ident_key: null, pkg_sha256: null, pkg_size: null,
    });
    return 1;
  }
  prepare(sql) {
    const self = this;
    return {
      bind(...args) {
        const run = () => self.exec(sql, args);
        return {
          run: async () => ({ meta: { changes: run() } }),
          first: async () => {
            const out = run();
            return Array.isArray(out) ? (out[0] || null) : out;
          },
          all: async () => {
            const out = run();
            return { results: Array.isArray(out) ? out : (out ? [out] : []) };
          },
        };
      },
    };
  }
  // Returns the changed-row count (or the row/rows for reads).
  exec(sql, a) {
    const R = (tid) => this.rows.get(tid);
    const set = (tid, patch) => { if (R(tid)) Object.assign(R(tid), patch); };
    switch (sql) {
      case FSQL.insertRow:
        return this.insert(a[0], a[1], a[2], a[3], a[4], a[5]);
      case FSQL.getRow:
        return R(a[0]) || null;
      case FSQL.listStatus:
        return [...this.rows.values()].filter((r) => r.status === a[0]);
      case FSQL.deleteRow: {
        const n = this.rows.delete(a[0]) ? 1 : 0;
        return n;
      }
      case FSQL.setPrompted: {
        const r = R(a[0]);
        if (r && r.status === "prompting") {
          set(a[0], { status: "awaiting", prompt_msg: a[1], prompt_sent_at: a[2], auto_due: a[3], last_msg_id: a[4] });
          return 1;
        }
        return 0;
      }
      case FSQL.packageAppeared: {
        const r = R(a[0]);
        if (r && r.status === "awaiting_package") { set(a[0], { status: "prompting", last_msg_id: a[1] }); return 1; }
        return 0;
      }
      case FSQL.startProcessing: {
        const r = R(a[0]);
        if (r && r.status === "awaiting") {
          set(a[0], { status: "processing", dispatched_at: a[1], attempts: r.attempts + 1 });
          return 1;
        }
        return 0;
      }
      case FSQL.revertToAwaiting: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { status: "awaiting", dispatched_at: null }); return 1; }
        return 0;
      }
      case FSQL.setDispatched: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { pkg_size: a[1], detail: "dispatched" }); return 1; }
        return 0;
      }
      case FSQL.markDeclined: {
        const r = R(a[0]);
        if (r && r.status === "awaiting") { set(a[0], { status: "declined" }); return 1; }
        return 0;
      }
      case FSQL.markUnconfirmed: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { status: "unconfirmed" }); return 1; }
        return 0;
      }
      case FSQL.markPublished: {
        const r = R(a[0]);
        if (r && (r.status === "processing" || r.status === "unconfirmed")) { set(a[0], { status: "published" }); return 1; }
        return 0;
      }
      case FSQL.markFailed: {
        const r = R(a[0]);
        if (r && r.status === "awaiting") { set(a[0], { status: "failed", detail: a[1] }); return 1; }
        return 0;
      }
      case FSQL.markFailedProcessing: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { status: "failed", detail: a[1] }); return 1; }
        return 0;
      }
      case FSQL.setUploaded: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { pkg_sha256: a[1], detail: "uploaded" }); return 1; }
        return 0;
      }
      case FSQL.touchLastMsg: {
        const r = R(a[0]);
        if (r) { set(a[0], { last_msg_id: a[1] }); return 1; }
        return 0;
      }
      case FSQL.setIdentKey: {
        const r = R(a[0]);
        if (r && r.status === "processing") { set(a[0], { ident_key: a[1] }); return 1; }
        return 0;
      }
      case FSQL.setPromptMsg: {
        const r = R(a[0]);
        if (r) { r.prompt_msg = a[1]; return 1; }
        return 0;
      }
      case FSQL.cleanupTerminal:
      case FSQL.cleanupAwaitingPackage:
      case FSQL.cleanupUnconfirmed: {
        let n = 0;
        for (const r of [...this.rows.values()]) {
          const hit =
            (sql === FSQL.cleanupTerminal &&
              ["published", "declined", "failed"].includes(r.status)) ||
            (sql === FSQL.cleanupAwaitingPackage && r.status === "awaiting_package") ||
            (sql === FSQL.cleanupUnconfirmed && r.status === "unconfirmed");
          if (hit && r.created_at < a[0]) { this.rows.delete(r.thread_id); n++; }
        }
        return n;
      }
      default:
        throw new Error(`FakeD1: unknown statement ${sql}`);
    }
  }
}

// The Discord/GitHub/catalog stand-in: URL-routed fake fetch.
function makeServices(overrides = {}) {
  const state = {
    activeThreads: overrides.activeThreads || [],
    archivedThreads: overrides.archivedThreads || [],
    archivedHasMore: false,
    threadObjects: new Map(overrides.threadObjects || []),   // tid -> thread object
    messages: new Map(overrides.messages || []),            // tid -> [message]
    users: new Map(overrides.users || []),                 // id -> user
    guildTags: overrides.guildTags || [],                  // [{id, name}]
    dispatchStatus: overrides.dispatchStatus ?? 204,
    catalog: overrides.catalog ?? { mods: [] },
    postPromptFail: !!overrides.postPromptFail,
    archivedThread: !!overrides.archivedThread,
    posts: [], edits: [], callbacks: [], dispatches: [],
    catalogFetches: [],
    deleted404: false,
  };
  // Thread list objects carry no `owner` object (live API verified): the
  // owner user is served by /users/{id}; register the helper's users.
  for (const list of [state.activeThreads, state.archivedThreads])
    for (const t of list)
      if (t && t.owner && !state.users.has(t.owner_id)) state.users.set(t.owner_id, t.owner);
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    const j = (obj, status = 200) => new Response(obj == null ? null : JSON.stringify(obj),
      { status, headers: { "Content-Type": "application/json", ...(obj && state.etag ? {} : {}) } });
    if (u.startsWith("https://discord.com/api/v10/guilds/") && u.endsWith("/threads/active"))
      return j({ threads: state.activeThreads });
    if (u.startsWith("https://discord.com/api/v10/guilds/") && u.endsWith("/tags"))
      return j(state.guildTags);
    const um = u.match(/^https:\/\/discord\.com\/api\/v10\/users\/([\w]+)$/);
    if (um) {
      const usr = state.users.get(um[1]) || { id: um[1], username: `name${um[1]}`, bot: false };
      return j(usr);
    }
    if (u.includes("/threads/archived/public")) {
      state.archivedRequestedWith = u;
      return j({ threads: state.archivedThreads, has_more: state.archivedHasMore });
    }
    let m;
    if ((m = u.match(/^https:\/\/discord\.com\/api\/v10\/channels\/(\d+)\/messages\?limit=50$/))) {
      const tid = m[1];
      if (state.deleted404 && state.messages.has(tid)) return new Response(null, { status: 404 });
      return j(state.messages.get(tid) || []);
    }
    if ((m = u.match(/^https:\/\/discord\.com\/api\/v10\/channels\/(\d+)\/messages$/))) {
      const id = `p${state.posts.length + 1}`;
      state.posts.push({ id, tid: m[1], ...(JSON.parse(init.body)) });
      if (state.postPromptFail) return new Response(null, { status: 500 });
      return j({ id });
    }
    if ((m = u.match(/^https:\/\/discord\.com\/api\/v10\/channels\/(\d+)\/messages\/([\w]+)$/))) {
      if (state.archivedThread) return new Response(
        JSON.stringify({ message: "Thread is archived", code: 50083 }), { status: 400 });
      state.edits.push({ tid: m[1], msgId: m[2], ...(JSON.parse(init.body)) });
      return new Response(null, { status: 204 });
    }
    if ((m = u.match(/^https:\/\/discord\.com\/api\/v10\/channels\/(\d+)$/))) {
      const t = state.threadObjects.get(m[1]);
      return t ? j(t) : new Response(null, { status: 404 });
    }
    if (u.startsWith("https://discord.com/api/v10/interactions/")) {
      state.callbacks.push(JSON.parse(init.body));
      return new Response(null, { status: 200 });
    }
    if (u === "https://catalog.test/catalog.json") {
      state.catalogFetches.push({ etag: init.headers && init.headers["If-None-Match"] || null });
      const body = JSON.stringify(state.catalog);
      if (state.lastServedCatalog !== undefined && body === state.lastServedCatalog
          && init.headers && init.headers["If-None-Match"] === `"abc"`)
        return new Response(null, { status: 304 });
      state.lastServedCatalog = body;
      return new Response(body, {
        status: 200, headers: { "Content-Type": "application/json", ETag: '"abc"' } });
    }
    if (u.endsWith("/actions/workflows/ingest-forum.yml/dispatches")) {
      state.dispatches.push(JSON.parse(init.body));
      return new Response(null, { status: state.dispatchStatus });
    }
    return new Response(null, { status: 204 });
  };
  return { fetchImpl, state };
}

function makeEnv(overrides = {}) {
  return {
    TOKENS: new FakeKV(),
    FORUM: new FakeD1(),
    DISCORD_BOT_TOKEN: "bot-token",
    GITHUB_OWNER: "o", GITHUB_REPO: "r", GITHUB_TOKEN: "gh-token",
    FORUM_GUILD_ID: "g1", FORUM_CHANNEL_ID: "c1",
    FORUM_TAG_MAP: "{}", FORUM_CUTOFF_THREAD_ID: "1000",
    CATALOG_URL: "https://catalog.test/catalog.json",
    UPLOAD_DAILY_BYTES: "1000000",
    FORUM_CALLBACK_SECRET: "s3cret",
    ...overrides,
  };
}

const NOW = new Date("2025-06-01T12:00:00.000Z");

function thread(id, { owner = "u1", bot = false, name = "My Mod", zip = null, image = null,
  tags = [], lastMessageId = null, messages = null } = {}) {
  const t = {
    id, type: 11, parent_id: "c1", owner_id: owner,
    owner: { id: owner, username: "ownername", bot },
    name, applied_tags: tags.map((n) => ({ id: n, name: n })),
    last_message_id: lastMessageId,
  };
  if (messages) return [t, messages];
  const msgs = [{ id: "m1", author: { id: owner, bot }, content: "hello world", attachments: [] }];
  if (zip) msgs[0].attachments.push({ filename: zip.filename || "mod.zip", url: zip.url || "https://cdn.discordapp.com/a.zip?ex=1", size: zip.size || 100 });
  if (image) msgs[0].attachments.push({ filename: image.filename || "cover.png", url: image.url || "https://cdn.discordapp.com/c.png?ex=1", size: 10, content_type: image.mime || "image/png" });
  return [t, msgs];
}

function setThread(d, { owner = "u1", bot = false, name = "My Mod", zip = null, image = null,
  tags = [], lastMessageId = "m1", messages } = {}) {
  const t = { id: "9000", type: 11, parent_id: "c1", owner_id: owner,
    owner: { id: owner, username: "ownername", bot }, name,
    applied_tags: tags.map((n) => ({ id: n, name: n })), last_message_id: lastMessageId };
  const m = [{ id: "m1", author: { id: owner, bot }, content: "hello world", attachments: [] }];
  if (zip) m[0].attachments.push({ filename: zip.filename || "mod.zip", url: zip.url || "https://cdn.discordapp.com/a.zip?ex=1", size: zip.size || 100 });
  if (image) m[0].attachments.push({ filename: image.filename || "cover.png", url: image.url || "https://cdn.discordapp.com/c.png?ex=1", size: 10, content_type: image.mime || "image/png" });
  d.state.threadObjects.set("9000", t);
  d.state.messages.set("9000", m);
  d.state.users.set(owner, { id: owner, username: "ownername", bot });
  return t;
}

// A D1 row in `awaiting` (prompt already posted) — the state a click finds.
function awaitingRow(env, { attempts = 0, status = "awaiting" } = {}) {
  env.FORUM.insert("9000", "u1", "ownername", status, "m1", NOW.toISOString());
  const row = env.FORUM.row("9000");
  row.prompt_msg = "p1";
  row.prompt_sent_at = NOW.toISOString();
  row.auto_due = NOW.toISOString();
  row.attempts = attempts;
  return row;
}

async function click(env, d, customId, clickerId) {
  return handleForumClick(env, d.fetchImpl, env.FORUM, { customId, clickerId }, NOW);
}

async function interaction(env, d, customId, clickerId) {
  env.DISCORD_PUBLIC_KEY = await publicKeyB64();
  const { fetchImpl } = d;
  const body = JSON.stringify({
    type: 3, id: "i1", token: "tok",
    data: { custom_id: customId },
    member: { user: { id: clickerId, username: "clicker" } },
    message: { id: "p1", channel_id: "9000" },
  });
  const timestamp = "1700000000";
  const data = new TextEncoder().encode(timestamp + body);
  const key = await keyPair();
  const sig = await crypto.subtle.sign("Ed25519", key.privateKey, data);
  return handle(new Request("https://worker.local/discord", {
    method: "POST", body,
    headers: {
      "X-Signature-Timestamp": timestamp,
      "X-Signature-Ed25519": Buffer.from(sig).toString("hex"),
    },
  }), env, fetchImpl);
}

let _keys = null;
async function keyPair() {
  if (!_keys) _keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return _keys;
}
async function publicKeyB64() {
  const { publicKey } = await keyPair();
  return Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64");
}

// ------------------------------------------------------------- tests

test("new thread with an owner zip gets a prompt; a duplicate tick prompts once", async () => {
  const [t, msgs] = thread("2001", { zip: {} });
  const env = makeEnv();
  const d = makeServices({ activeThreads: [t], messages: [["2001", msgs]] });
  const r1 = await forumTick(env, d.fetchImpl, NOW);
  assert.equal(r1.prompts, 1, "prompt posted");
  assert.equal(env.FORUM.row("2001").status, "awaiting");
  const auto = new Date(NOW.getTime() + 36 * 3600 * 1000).toISOString();
  assert.equal(env.FORUM.row("2001").auto_due, auto, "auto_due anchored to prompt time");
  // second tick, same state: no new prompt
  const r2 = await forumTick(env, d.fetchImpl, NOW);
  assert.equal(r2.prompts, 0, "no second prompt");
  assert.equal(d.state.posts.length, 1);
  assert.ok(d.state.posts[0].content.includes("Publish this package"));
  assert.ok(d.state.posts[0].components[0].components[0].custom_id.startsWith("forum_publish:2001"));
});

test("two concurrent ticks: exactly one prompt (INSERT OR IGNORE)", async () => {
  const [t, msgs] = thread("2002", { zip: {} });
  const env = makeEnv();
  const d = makeServices({ activeThreads: [t], messages: [["2002", msgs]] });
  await Promise.all([forumTick(env, d.fetchImpl, NOW), forumTick(env, d.fetchImpl, NOW)]);
  assert.equal(d.state.posts.length, 1, "exactly one prompt");
  assert.equal(env.FORUM.row("2002").status, "awaiting");
});

test("owner-only attachments: a third party's zip is ignored", async () => {
  const [t, msgs] = thread("2003", {});
  // a third-party reply with a zip; the owner's message has none
  msgs.push({ id: "m2", author: { id: "intruder" }, content: "here",
    attachments: [{ filename: "evil.zip", url: "https://cdn.discordapp.com/e.zip?ex=1", size: 50 }] });
  const env = makeEnv();
  const d = makeServices({ activeThreads: [t], messages: [["2003", msgs]] });
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("2003").status, "awaiting_package", "no owner zip -> awaiting_package, no prompt");
  assert.equal(d.state.posts.length, 0);

  // the owner later attaches a zip (a new message): the next tick prompts
  msgs.push({ id: "m3", author: { id: "u1" }, content: "here you go",
    attachments: [{ filename: "mine.zip", url: "https://cdn.discordapp.com/m.zip?ex=1", size: 60 }] });
  t.last_message_id = "m3";
  const d2 = makeServices({ activeThreads: [t], messages: [["2003", msgs]] });
  await forumTick(env, d2.fetchImpl, NOW);
  assert.equal(env.FORUM.row("2003").status, "awaiting", "zip appeared -> prompt -> awaiting");
  assert.equal(d2.state.posts.length, 1);
});

test("bot-authored threads are skipped", async () => {
  const [t, msgs] = thread("2004", { bot: true, zip: {} });
  const env = makeEnv();
  const d = makeServices({ activeThreads: [t], messages: [["2004", msgs]] });
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("2004"), null, "no row for a bot thread");
});

test("threads at/below the cutoff are never considered", async () => {
  const [t, msgs] = thread("1000", { zip: {} });
  const env = makeEnv();
  const d = makeServices({ activeThreads: [t], messages: [["1000", msgs]] });
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("1000"), null);
});

test("a click by a non-owner is rejected ephemerally; no state change", async () => {
  const env = makeEnv();
  const d = makeServices();
  setThread(d, { zip: {} });
  awaitingRow(env);
  const res = await interaction(env, d, "forum_publish:9000", "someone-else");
  assert.equal(res.status, 202);
  const cb = d.state.callbacks.at(-1);
  assert.equal(cb.type, 7, "ephemeral reply");
  assert.match(cb.data.content, /Only the thread's author/);
  assert.equal(env.FORUM.row("9000").status, "awaiting", "unchanged");
  assert.equal(d.state.dispatches.length, 0);
});

test("a click by the owner dispatches exactly once; a double click and a tick race dispatch once", async () => {
  const env = makeEnv();
  const d = makeServices();
  setThread(d, { zip: {} });
  awaitingRow(env);

  // the owner clicks AND the auto tick runs at the same time
  await Promise.all([
    click(env, d, "forum_publish:9000", "u1"),
    forumTick(env, d.fetchImpl, NOW),
  ]);
  assert.equal(d.state.dispatches.length, 1, "exactly one dispatch");
  assert.equal(env.FORUM.row("9000").status, "processing");
  assert.equal(env.FORUM.row("9000").attempts, 1);

  // a late second click: no second dispatch
  await click(env, d, "forum_publish:9000", "u1");
  assert.equal(d.state.dispatches.length, 1, "still one dispatch");

  // the dispatch payload
  const inputs = d.state.dispatches[0].inputs;
  assert.equal(inputs.thread_id, "9000");
  assert.equal(inputs.upload_id, "forum-9000");
  assert.ok(inputs.stamp.startsWith("u1-"), "stamp = <discordId>-<hex username>");
  const meta = JSON.parse(inputs.metadata);
  assert.equal(meta.title, "My Mod");
  assert.equal(meta.version, "");
  assert.equal(meta.author, "ownername");
  assert.equal(inputs.package_url, "https://cdn.discordapp.com/a.zip?ex=1");
  assert.equal(env.FORUM.row("9000").ident_key, "u1.mymod", "ident_key computed at dispatch");
  // the prompt was edited to processing (buttons removed)
  const edit = d.state.edits.at(-1);
  assert.match(edit.content, /Processing/);
  assert.deepEqual(edit.components, []);
  // the quota was charged
  assert.equal(JSON.parse(await env.TOKENS.get("quota:u1")).bytes, 100);
});

test("the 36h auto path is anchored to the prompt time, not the post time", async () => {
  const env = makeEnv();
  const d = makeServices();
  const t = setThread(d, { zip: {} });
  const row = awaitingRow(env);
  row.created_at = "2025-05-01T00:00:00Z";
  // 1 s before the auto deadline: no dispatch
  const d1 = makeServices({ activeThreads: [t] });
  row.auto_due = new Date(NOW.getTime() + 1000).toISOString();
  await forumTick(env, d1.fetchImpl, NOW);
  assert.equal(d1.state.dispatches.length, 0, "before the deadline: nothing");
  // at the deadline: dispatch
  row.auto_due = NOW.toISOString();
  const d3 = makeServices({ activeThreads: [t] });
  setThread(d3, { zip: {} });
  await forumTick(env, d3.fetchImpl, NOW);
  assert.equal(d3.state.dispatches.length, 1, "at the deadline: dispatched");
});

test("decline is terminal and suppresses the auto-publish", async () => {
  const env = makeEnv();
  const d = makeServices();
  setThread(d, { zip: {} });
  awaitingRow(env);
  const res = await click(env, d, "forum_decline:9000", "u1");
  assert.equal(res, null);
  assert.equal(env.FORUM.row("9000").status, "declined");
  const edit = d.state.edits.at(-1);
  assert.match(edit.content, /Declined/);
  assert.deepEqual(edit.components, []);
  // a later tick (auto already due) does not dispatch
  await forumTick(env, d.fetchImpl, new Date(NOW.getTime() + 37 * 3600 * 1000));
  assert.equal(d.state.dispatches.length, 0, "declined suppresses auto");
});

test("a late click on a non-awaiting row replies without acting", async () => {
  const env = makeEnv();
  const d = makeServices();
  setThread(d, { zip: {} });
  awaitingRow(env, { status: "processing" });
  const res = await click(env, d, "forum_publish:9000", "u1");
  assert.match(res.content, /Already processing/);
  assert.equal(d.state.dispatches.length, 0);
});

test("a deleted thread (404) deletes the row; no upload", async () => {
  const env = makeEnv();
  const t = { id: "9000", type: 11, parent_id: "c1", owner_id: "u1",
    owner: { id: "u1", username: "ownername", bot: false }, name: "My Mod" };
  const d = makeServices({ activeThreads: [t] });
  setThread(d, { zip: {} });
  awaitingRow(env);
  const d2 = makeServices({ activeThreads: [t] });
  d2.state.deleted404 = true;
  d2.state.messages.set("9000", []);
  await forumTick(env, d2.fetchImpl, NOW);
  assert.equal(env.FORUM.row("9000"), null, "row deleted");
  assert.equal(d2.state.dispatches.length, 0);
});

test("dispatch failure: revert to awaiting + retry; after 3 attempts -> failed", async () => {
  const env = makeEnv();
  const d = makeServices({ dispatchStatus: 500 });
  setThread(d, { zip: {} });
  awaitingRow(env);
  await click(env, d, "forum_publish:9000", "u1");
  assert.equal(env.FORUM.row("9000").status, "awaiting", "reverted");
  assert.equal(env.FORUM.row("9000").attempts, 1);
  const retryEdit = d.state.edits.at(-1);
  assert.match(retryEdit.content, /retried automatically/);
  assert.ok(retryEdit.components.length === 1, "buttons restored for the retry");

  // two more failures exhaust the attempts
  for (let i = 0; i < 2; i++) {
    await click(env, d, "forum_publish:9000", "u1");
  }
  assert.equal(env.FORUM.row("9000").attempts, 3);
  assert.equal(env.FORUM.row("9000").status, "failed", "failed after 3 attempts");
  assert.match(d.state.edits.at(-1).content, /3 times/);
  // three failed attempts total (all 500); the prompt says failed
  assert.equal(d.state.dispatches.length, 3, "three attempts, all failed");
  // no successful dispatch ever happened; no quota was charged
  assert.equal(await env.TOKENS.get("quota:u1"), null);
});

test("a row with 3 prior attempts fails without dispatching", async () => {
  const env = makeEnv();
  const d = makeServices();
  setThread(d, { zip: {} });
  awaitingRow(env, { attempts: 3 });
  await click(env, d, "forum_publish:9000", "u1");
  assert.equal(env.FORUM.row("9000").status, "failed");
  assert.equal(d.state.dispatches.length, 0);
});

test("quota: exceeded -> terminal failed with a clear message, no dispatch", async () => {
  const env = makeEnv({ UPLOAD_DAILY_BYTES: "150" });
  await env.TOKENS.put("quota:u1", JSON.stringify({ date: NOW.toISOString().slice(0, 10), bytes: 100 }));
  const d = makeServices();
  setThread(d, { zip: { size: 100 } }); // 100 + 100 > 150
  awaitingRow(env);
  await click(env, d, "forum_publish:9000", "u1");
  assert.equal(env.FORUM.row("9000").status, "failed", "terminal: no per-tick retry spam");
  assert.match(env.FORUM.row("9000").detail, /daily upload limit reached/);
  assert.equal(d.state.dispatches.length, 0);
  assert.match(d.state.edits.at(-1).content, /daily upload limit reached/);
});

test("ingest failure callback: refund + failed + prompt edit; uploaded callback stores the sha", async () => {
  const env = makeEnv();
  const d = makeServices();
  // a processed row: processing, pkg_size charged
  env.FORUM.insert("9000", "u1", "ownername", "processing", "m1", NOW.toISOString());
  const row = env.FORUM.row("9000");
  row.prompt_msg = "p1";
  row.dispatched_at = NOW.toISOString();
  row.pkg_size = 100;
  await env.TOKENS.put("quota:u1", JSON.stringify({ date: NOW.toISOString().slice(0, 10), bytes: 100 }));

  const post = async (obj, sig) => handleForumStatus(new Request("https://worker.local/forum/status", {
    method: "POST", body: JSON.stringify(obj),
    headers: { "Content-Type": "application/json", ...(sig ? { "X-Forum-Signature": sig } : {}) },
  }), env, d.fetchImpl, NOW);
  const sign = async (body) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode("s3cret"),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex");
  };
  const body1 = JSON.stringify({ thread_id: "9000", status: "failed", reason: "bad package" });
  const res1 = await post(JSON.parse(body1), await sign(body1));
  assert.equal(res1.status, 204);
  assert.equal(env.FORUM.row("9000").status, "failed");
  assert.equal(env.FORUM.row("9000").detail, "bad package");
  assert.equal(JSON.parse(await env.TOKENS.get("quota:u1")).bytes, 0, "quota refunded");
  assert.match(d.state.edits.at(-1).content, /bad package/);

  // uploaded callback (a fresh processing row)
  row.status = "processing";
  row.pkg_size = null;
  row.pkg_sha256 = null;
  const sha = "ab".repeat(32);
  const body2 = JSON.stringify({ thread_id: "9000", status: "uploaded", pkg_sha256: sha });
  const res2 = await post(JSON.parse(body2), await sign(body2));
  assert.equal(res2.status, 204);
  assert.equal(env.FORUM.row("9000").pkg_sha256, sha);
  assert.equal(env.FORUM.row("9000").detail, "uploaded");
});

test("status callback: bad signature is rejected; only processing rows are acted on", async () => {
  const env = makeEnv();
  const d = makeServices();
  awaitingRow(env);
  const body = JSON.stringify({ thread_id: "9000", status: "failed", reason: "x" });
  const res = await handleForumStatus(new Request("https://worker.local/forum/status", {
    method: "POST", body, headers: { "X-Forum-Signature": "aa".repeat(32) },
  }), env, d.fetchImpl);
  assert.equal(res.status, 401, "bad signature");
  assert.equal(env.FORUM.row("9000").status, "awaiting", "no change");
});

test("watchdog: processing without confirmation -> unconfirmed; later catalog appearance -> published", async () => {
  const env = makeEnv();
  const d = makeServices({ catalog: { mods: [] } });
  env.FORUM.insert("9000", "u1", "ownername", "processing", "m1", NOW.toISOString());
  const row = env.FORUM.row("9000");
  row.prompt_msg = "p1";
  row.dispatched_at = new Date(NOW.getTime() - 31 * 60 * 1000).toISOString();
  row.ident_key = "u1.mymod";
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("9000").status, "unconfirmed", "watchdog fired");
  assert.match(d.state.edits.at(-1).content, /No confirmation yet/);
  // a fresh row (still processing, recent) is NOT touched
  row.status = "processing";
  row.dispatched_at = NOW.toISOString();
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("9000").status, "processing", "recent processing untouched");
  // the mod appears in the catalog (updated >= dispatched_at)
  d.state.catalog = { mods: [{ id: "u1.MyMod", updated: NOW.toISOString() }] };
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("9000").status, "published");
  assert.match(d.state.edits.at(-1).content, /Published/);
  // an OLD catalog entry (updated < dispatched_at) must NOT count (collision case)
  row.status = "processing";
  row.dispatched_at = NOW.toISOString();
  d.state.catalog = { mods: [{ id: "u1.MyMod", updated: "2025-01-01T00:00:00Z" }] };
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("9000").status, "processing", "stale entry: not published");
});

test("an unconfirmed row flips to published when the mod appears later", async () => {
  const env = makeEnv();
  const d = makeServices({ catalog: { mods: [{ id: "u1.MyMod", updated: NOW.toISOString() }] } });
  env.FORUM.insert("9000", "u1", "ownername", "unconfirmed", "m1", NOW.toISOString());
  const row = env.FORUM.row("9000");
  row.prompt_msg = "p1";
  row.dispatched_at = new Date(NOW.getTime() - 2 * 3600 * 1000).toISOString();
  row.ident_key = "u1.mymod";
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("9000").status, "published", "late confirmation wins");
});

test("cleanup: awaiting_package > 36h, terminal rows > 48h, unconfirmed > 48h", async () => {
  const env = makeEnv();
  const d = makeServices();
  const old36 = new Date(NOW.getTime() - 37 * 3600 * 1000).toISOString();
  const old48 = new Date(NOW.getTime() - 49 * 3600 * 1000).toISOString();
  const mk = (tid, status, created) => env.FORUM.insert(tid, "u1", "n", status, "m1", created);
  mk("3001", "awaiting_package", old36);
  mk("3002", "awaiting_package", NOW.toISOString());
  mk("3003", "published", old48);
  mk("3004", "declined", old48);
  mk("3005", "failed", old48);
  mk("3006", "unconfirmed", old48);
  mk("3007", "unconfirmed", NOW.toISOString());
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("3001"), null, "awaiting_package swept");
  assert.ok(env.FORUM.row("3002"), "recent awaiting_package kept");
  assert.equal(env.FORUM.row("3003"), null, "published swept");
  assert.equal(env.FORUM.row("3004"), null, "declined swept");
  assert.equal(env.FORUM.row("3005"), null, "failed swept");
  assert.equal(env.FORUM.row("3006"), null, "unconfirmed swept at 48h");
  assert.ok(env.FORUM.row("3007"), "recent unconfirmed kept (still reconciling)");
});

test("a stuck prompting row (prompt post failed) is retried on a later tick", async () => {
  const env = makeEnv();
  const [t, msgs] = thread("2005", { zip: {} });
  const d = makeServices({ activeThreads: [t], postPromptFail: true, messages: [["2005", msgs]] });
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(env.FORUM.row("2005").status, "prompting", "stuck: post failed");
  assert.equal(env.FORUM.row("2005").prompt_msg, null);
  // 20 minutes later the Discord post succeeds
  env.FORUM.row("2005").created_at = new Date(NOW.getTime() - 20 * 60 * 1000).toISOString();
  const d2 = makeServices({ activeThreads: [t], messages: [["2005", msgs]] });
  const r = await forumTick(env, d2.fetchImpl, NOW);
  assert.equal(r.prompts, 1, "retried and posted");
  assert.equal(env.FORUM.row("2005").status, "awaiting");
});

test("the catalog is fetched only when needed, with ETag", async () => {
  const env = makeEnv();
  // no candidates, no pending rows: no catalog fetch
  const d = makeServices();
  await forumTick(env, d.fetchImpl, NOW);
  assert.equal(d.state.catalogFetches.length, 0, "no catalog fetch without need");
  // a pending row: fetched, and the second tick uses the ETag
  env.FORUM.insert("9000", "u1", "ownername", "processing", "m1", NOW.toISOString());
  const row = env.FORUM.row("9000");
  row.prompt_msg = "p1";
  row.dispatched_at = NOW.toISOString();
  row.ident_key = "u1.mymod";
  const d1 = makeServices();
  await forumTick(env, d1.fetchImpl, NOW);
  assert.equal(d1.state.catalogFetches.length, 1);
  assert.equal(d1.state.catalogFetches[0].etag, null, "first fetch: no ETag");
  await forumTick(env, d1.fetchImpl, NOW);
  assert.equal(d1.state.catalogFetches[1].etag, '"abc"', "second fetch: ETag (304 path)");
});

test("a prompt warns when the identifier already exists in the catalog", async () => {
  const env = makeEnv();
  const [t, msgs] = thread("2006", { zip: {} });
  const d = makeServices({ activeThreads: [t], messages: [["2006", msgs]],
    catalog: { mods: [{ id: "u1.MyMod", updated: "2025-01-01T00:00:00Z" }] } });
  await forumTick(env, d.fetchImpl, NOW);
  assert.ok(d.state.posts[0].content.includes("A mod with this name already exists"), "warning in the prompt");
});

test("tags are mapped through FORUM_TAG_MAP", async () => {
  const env = makeEnv({ FORUM_TAG_MAP: JSON.stringify({ "my-tag": "Skin" }) });
  const d = makeServices();
  setThread(d, { zip: {}, tags: ["my-tag", "unknown-tag"] });
  awaitingRow(env);
  await click(env, d, "forum_publish:9000", "u1");
  const meta = JSON.parse(d.state.dispatches[0].inputs.metadata);
  assert.deepEqual(meta.tags, ["Skin", "unknown-tag"], "mapped + pass-through (dropped later by sanitize_tags)");
});

test("a zip that vanished before dispatch fails gracefully", async () => {
  const env = makeEnv();
  const d = makeServices();
  setThread(d, {}); // no zip now
  awaitingRow(env);
  await click(env, d, "forum_publish:9000", "u1");
  assert.equal(env.FORUM.row("9000").status, "failed");
  assert.match(env.FORUM.row("9000").detail, /no longer attached/);
  assert.match(d.state.edits.at(-1).content, /no longer attached/);
  assert.equal(d.state.dispatches.length, 0);
});

test("an archived thread: prompt updates post a fresh message and re-point the row", async () => {
  const env = makeEnv();
  const d = makeServices();
  setThread(d, { zip: {} });
  awaitingRow(env);
  env.FORUM.row("9000").prompt_msg = "px"; // a prompt id with no matching post in the fake
  await click(env, d, "forum_publish:9000", "u1");
  assert.equal(env.FORUM.row("9000").status, "processing");
  const firstPrompt = env.FORUM.row("9000").prompt_msg;
  // the thread is now archived: PATCH of the prompt message 400s (50083,
  // verified live) — the fallback posts a fresh message and the row
  // points at it
  d.state.archivedThread = true;
  const post = async (obj, sig) => handleForumStatus(new Request("https://worker.local/forum/status", {
    method: "POST", body: JSON.stringify(obj),
    headers: { "X-Forum-Signature": sig } }), env, d.fetchImpl);
  const sign = async (body) => {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.FORUM_CALLBACK_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body))).toString("hex");
  };
  const sha = "ab".repeat(32);
  const body = JSON.stringify({ thread_id: "9000", status: "failed", reason: "the ingest failed" });
  const res = await post(JSON.parse(body), await sign(body));
  assert.equal(res.status, 204);
  assert.equal(env.FORUM.row("9000").status, "failed");
  assert.match(env.FORUM.row("9000").detail, /the ingest failed/);
  const fresh = d.state.posts.at(-1);
  assert.ok(fresh, "a fresh message was posted");
  assert.match(fresh.content, /Couldn't publish/);
  assert.notEqual(fresh.id, firstPrompt, "the row points at the fresh message");
  assert.equal(env.FORUM.row("9000").prompt_msg, fresh.id);
});
