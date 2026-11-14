// Offline tests for the /catalog/events mirror (node --test, Node 20+).
//
// A programmable fake fetch records the Discord calls; FakeD1 stands
// in for D1. Nothing touches the network.

import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { handleCatalogEvents } from "../src/mirror.js";
import { FakeD1 } from "./helpers/fake-d1.js";

const SECRET = "test-callback-secret";

function makeEnv(overrides = {}) {
  const db = new FakeD1();
  return {
    DB: db,
    CATALOG_CALLBACK_SECRET: SECRET,
    DISCORD_BOT_TOKEN: "test-bot-token",
    FORUM_CHANNEL_ID: "77",
    SITE_URL: "https://pages.example.com/",
    FORUM_TAG_IDS: JSON.stringify({ Blueprint: "9001", Skin: "9002" }),
    NOTICES_CHANNEL_ID: "88",
    ...overrides,
  };
}

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler ? handler(calls.length - 1, url, init) : new Response(null, { status: 204 });
  };
  fn.calls = calls;
  return fn;
}

async function hmac(secret, raw) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function publishedEvent(over = {}) {
  return {
    eventId: "123.coolmod:abc123",
    status: "published",
    mode: "new",
    uploaderId: "42",
    uploaderName: "alice",
    title: "Cool Mod",
    version: "1.0",
    description: "A fine mod",
    author: "alice",
    identifier: "123.CoolMod",
    tags: ["Blueprint", "Nonsense"],
    gameVersion: "0.0",
    fileUrl: "https://files/x.zip",
    coverUrl: "https://files/cover.png",
    size: 100,
    sha256: "abc123",
    assetName: "Cool-Mod-1.0.zip",
    ...over,
  };
}

function rejectedEvent(over = {}) {
  return {
    eventId: "rej:42:gid1",
    status: "rejected",
    mode: null,
    uploaderId: "42",
    uploaderName: "alice",
    reason: "a package without a trailer",
    title: "No Trailer",
    version: null,
    identifier: null,
    ...over,
  };
}

// A signed request; `tsOffset` (seconds) shifts the timestamp.
async function eventsRequest(events, { secret = SECRET, tsOffset = 0, tamper = false } = {}) {
  const body = JSON.stringify({ ts: Math.floor(Date.now() / 1000) + tsOffset, events });
  const raw = tamper ? body.replace('"published"', '"rejected"') : body;
  const headers = { "Content-Type": "application/json" };
  if (secret != null) headers["X-Catalog-Signature"] = await hmac(secret, body);
  return new Request("https://worker.local/catalog/events", { method: "POST", body: raw, headers });
}

const res = async (req, env, f) => handle(req, env, f);
const json = async (r) => r.json();

// ------------------------------------------------------------ auth

test("GET is rejected 405", async () => {
  const r = await res(new Request("https://worker.local/catalog/events"), makeEnv(), makeFetch());
  assert.equal(r.status, 405);
});

test("missing signature is rejected 401", async () => {
  const r = await res(await eventsRequest([publishedEvent()], { secret: null }), makeEnv(), makeFetch());
  assert.equal(r.status, 401);
});

test("bad signature is rejected 401", async () => {
  const r = await res(await eventsRequest([publishedEvent()], { secret: "other" }), makeEnv(), makeFetch());
  assert.equal(r.status, 401);
});

test("a tampered body is rejected 401", async () => {
  const r = await res(await eventsRequest([publishedEvent()], { tamper: true }), makeEnv(), makeFetch());
  assert.equal(r.status, 401);
});

test("a stale timestamp is rejected 401", async () => {
  const r = await res(await eventsRequest([publishedEvent()], { tsOffset: -600 }), makeEnv(), makeFetch());
  assert.equal(r.status, 401);
});

test("a future timestamp beyond the window is rejected 401", async () => {
  const r = await res(await eventsRequest([publishedEvent()], { tsOffset: +600 }), makeEnv(), makeFetch());
  assert.equal(r.status, 401);
});

test("more than 10 events is rejected 400", async () => {
  const ten = Array.from({ length: 11 }, (_, i) => publishedEvent({ eventId: `e${i}`, identifier: `123.Mod${i}` }));
  const r = await res(await eventsRequest(ten), makeEnv(), makeFetch());
  assert.equal(r.status, 400);
});

test("an over-size body is rejected 400", async () => {
  const big = JSON.stringify({ ts: Math.floor(Date.now() / 1000), events: [publishedEvent()], pad: "x".repeat(300 * 1024) });
  const headers = { "Content-Type": "application/json", "X-Catalog-Signature": await hmac(SECRET, big) };
  const r = await res(new Request("https://worker.local/catalog/events", { method: "POST", body: big, headers }), makeEnv(), makeFetch());
  assert.equal(r.status, 400);
});

test("a bad event shape is rejected 400", async () => {
  const r = await res(await eventsRequest([publishedEvent({ status: "meh" })]), makeEnv(), makeFetch());
  assert.equal(r.status, 400);
});

// ------------------------------------------------- published events

const threadOk = () => new Response(JSON.stringify({ id: "t-1" }), { status: 200 });
const msgOk = () => new Response(JSON.stringify({ id: "m-1" }), { status: 200 });

test("a new published event creates the forum thread once", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => (url.includes("/threads") ? threadOk() : msgOk()));
  const r = await res(await eventsRequest([publishedEvent()]), env, f);
  assert.equal(r.status, 200);
  const body = await json(r);
  assert.deepEqual(body.results, [{ eventId: "123.coolmod:abc123", ok: true }]);
  const create = f.calls.find((c) => c.url.endsWith("/channels/77/threads"));
  assert.ok(create, "one thread create");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/threads")).length, 1);
  const p = JSON.parse(create.init.body);
  assert.equal(p.name, "Cool Mod");
  assert.ok(p.message.content.includes("<@42> published **Cool Mod** v1.0"), p.message.content);
  assert.ok(p.message.content.includes("A fine mod"));
  assert.ok(p.message.content.includes("https://pages.example.com/"));
  assert.deepEqual(p.message.allowed_mentions, { parse: [], users: ["42"] });
  assert.deepEqual(p.applied_tags, ["9001"]); // "Nonsense" is not in FORUM_TAG_IDS
  assert.deepEqual(p.message.embeds, [{
    image: { url: "https://files/cover.png" },
    footer: { text: "mod-id: 123.CoolMod" },
  }]);
  assert.equal(create.init.headers.Authorization, "Bot test-bot-token");
  assert.equal(env.DB.modThread("123.coolmod").thread_id, "t-1");
  assert.ok(env.DB.seenEvent("123.coolmod:abc123"), "eventId recorded");
});

test("a published event without a cover omits the embed image", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => (url.includes("/threads") ? threadOk() : msgOk()));
  const r = await res(await eventsRequest([publishedEvent({ coverUrl: null, tags: [] })]), env, f);
  assert.equal(r.status, 200);
  const p = JSON.parse(f.calls.find((c) => c.url.endsWith("/threads")).init.body);
  assert.deepEqual(p.message.embeds, [{ footer: { text: "mod-id: 123.CoolMod" } }]);
  assert.deepEqual(p.applied_tags, []);
});

test("an update event posts into the existing thread (no new thread)", async () => {
  const env = makeEnv();
  env.DB.threads.set("123.coolmod", { mod_key: "123.coolmod", thread_id: "t-1", created_at: "2026-01-01T00:00:00Z" });
  const f = makeFetch((i, url) => (url.includes("/threads") ? threadOk() : msgOk()));
  const r = await res(await eventsRequest([publishedEvent({ mode: "update", version: "1.1", eventId: "123.coolmod:def" })]), env, f);
  assert.equal(r.status, 200);
  const msg = f.calls.find((c) => c.url.endsWith("/channels/t-1/messages"));
  assert.ok(msg, "a message in the existing thread");
  assert.equal(f.calls.filter((c) => c.url.endsWith("/threads")).length, 0, "no new thread");
  const p = JSON.parse(msg.init.body);
  assert.ok(p.content.includes("<@42> uploaded **v1.1**"), p.content);
  assert.ok(p.content.includes("A fine mod"));
  assert.deepEqual(p.allowed_mentions, { parse: [], users: ["42"] });
  assert.deepEqual(p.embeds, [{ image: { url: "https://files/cover.png" }, footer: { text: "mod-id: 123.CoolMod" } }]);
});

test("a deleted-thread 404 re-creates the thread and replaces the mapping", async () => {
  const env = makeEnv();
  env.DB.threads.set("123.coolmod", { mod_key: "123.coolmod", thread_id: "t-gone", created_at: "2026-01-01T00:00:00Z" });
  const f = makeFetch((i, url) => {
    if (url.endsWith("/channels/t-gone/messages")) return new Response(null, { status: 404 });
    if (url.endsWith("/channels/77/threads")) return new Response(JSON.stringify({ id: "t-2" }), { status: 200 });
    return msgOk();
  });
  const r = await res(await eventsRequest([publishedEvent({ mode: "update", eventId: "123.coolmod:def" })]), env, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { results: [{ eventId: "123.coolmod:def", ok: true }] });
  assert.equal(env.DB.modThread("123.coolmod").thread_id, "t-2");
});

test("an over-long title is truncated to the thread-name limit", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => (url.includes("/threads") ? threadOk() : msgOk()));
  const r = await res(await eventsRequest([publishedEvent({ title: "x".repeat(300), description: "y".repeat(500) })]), env, f);
  assert.equal(r.status, 200);
  const p = JSON.parse(f.calls.find((c) => c.url.endsWith("/threads")).init.body);
  assert.equal(p.name.length, 100);
  assert.ok(p.message.content.length <= 2000); // content capped too
});

test("a title containing @everyone never produces a mass mention", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => (url.includes("/threads") ? threadOk() : msgOk()));
  const r = await res(await eventsRequest([publishedEvent({ title: "@everyone" })]), env, f);
  assert.equal(r.status, 200);
  const p = JSON.parse(f.calls.find((c) => c.url.endsWith("/threads")).init.body);
  assert.ok(!p.message.content.includes("@everyone"), p.message.content);
  assert.deepEqual(p.message.allowed_mentions, { parse: [], users: ["42"] });
});

// ------------------------------------------------- rejected events

test("a rejected event posts a user-only mention notice", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => msgOk());
  const r = await res(await eventsRequest([rejectedEvent()]), env, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { results: [{ eventId: "rej:42:gid1", ok: true }] });
  const msg = f.calls.find((c) => c.url.endsWith("/channels/88/messages"));
  assert.ok(msg, "a notice in the notices channel");
  const p = JSON.parse(msg.init.body);
  assert.equal(p.content, "<@42> your upload of **No Trailer** was not accepted: a package without a trailer");
  assert.deepEqual(p.allowed_mentions, { parse: [], users: ["42"] });
  assert.ok(env.DB.seenEvent("rej:42:gid1"));
});

test("a rejected event with no title says unknown", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => msgOk());
  await res(await eventsRequest([rejectedEvent({ title: null })]), env, f);
  const p = JSON.parse(f.calls.find((c) => c.url.endsWith("/channels/88/messages")).init.body);
  assert.ok(p.content.includes("**unknown**"), p.content);
});

test("a rejected event with NOTICES unset posts nothing and still succeeds", async () => {
  const env = makeEnv({ NOTICES_CHANNEL_ID: "" });
  const f = makeFetch((i, url) => msgOk());
  const r = await res(await eventsRequest([rejectedEvent()]), env, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { results: [{ eventId: "rej:42:gid1", ok: true }] });
  assert.equal(f.calls.length, 0, "no Discord call");
});

// ------------------------------------------------ idempotency + retry

test("a duplicate delivery is skipped and makes zero Discord calls", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => (url.includes("/threads") ? threadOk() : msgOk()));
  const req = await eventsRequest([publishedEvent(), rejectedEvent()]);
  const r1 = await res(req.clone(), env, f);
  assert.equal(r1.status, 200);
  const before = f.calls.length;
  const r2 = await res(req.clone(), env, f);
  assert.equal(r2.status, 200);
  assert.deepEqual(await json(r2), { results: [
    { eventId: "123.coolmod:abc123", ok: true, skipped: true },
    { eventId: "rej:42:gid1", ok: true, skipped: true },
  ] });
  assert.equal(f.calls.length, before, "no extra Discord calls");
});

test("a failing event does not block the next, and redelivers cleanly", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => {
    if (url.endsWith("/channels/77/threads"))
      return i === 0 ? new Response("boom", { status: 500 }) : threadOk();
    return msgOk();
  });
  const ev1 = publishedEvent();
  const ev2 = publishedEvent({ eventId: "123.other:zzz", identifier: "123.Other", title: "Other" });
  const r1 = await res(await eventsRequest([ev1, ev2]), env, f);
  assert.equal(r1.status, 200);
  const b1 = await json(r1);
  assert.equal(b1.results[0].ok, false);
  assert.match(b1.results[0].error, /500/);
  assert.equal(b1.results[1].ok, true, "the second event went through");
  assert.ok(!env.DB.seenEvent(ev1.eventId), "the failed event is not recorded");
  assert.ok(env.DB.modThread("123.other"));
  // redelivery: ev1 now succeeds, ev2 is skipped
  const r2 = await res(await eventsRequest([ev1, ev2]), env, f);
  const b2 = await json(r2);
  assert.equal(b2.results[0].ok, true);
  assert.equal(b2.results[1].skipped, true);
  assert.equal(env.DB.modThread("123.coolmod").thread_id, "t-1");
});

test("a 429 with retry_after is retried once", async () => {
  const env = makeEnv();
  let attempts = 0;
  const f = makeFetch((i, url) => {
    if (url.endsWith("/channels/77/threads")) {
      attempts++;
      return attempts === 1
        ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 })
        : threadOk();
    }
    return msgOk();
  });
  const r = await res(await eventsRequest([publishedEvent()]), env, f);
  assert.equal(r.status, 200);
  assert.deepEqual(await json(r), { results: [{ eventId: "123.coolmod:abc123", ok: true }] });
  assert.equal(attempts, 2, "the 429 was retried exactly once");
});

test("two 429s in a row fail the event (no further retries)", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => (url.endsWith("/channels/77/threads")
    ? new Response(JSON.stringify({ retry_after: 0 }), { status: 429 })
    : msgOk()));
  const r = await res(await eventsRequest([publishedEvent()]), env, f);
  assert.equal(r.status, 200);
  const b = await json(r);
  assert.equal(b.results[0].ok, false);
  assert.ok(!env.DB.seenEvent(publishedEvent().eventId), "not recorded for retry");
});

test("handleCatalogEvents is routed like the other handlers", async () => {
  const env = makeEnv();
  const f = makeFetch((i, url) => (url.includes("/threads") ? threadOk() : msgOk()));
  const direct = await handleCatalogEvents(await eventsRequest([publishedEvent()]), env, f);
  assert.equal(direct.status, 200);
});
