// Offline tests for the ModCatalog Worker (node --test, Node 20+).
//
// Fake KV (a Map), injected fetch (records calls), and a generated Ed25519
// keypair stand in for Cloudflare/Discord/Github. Nothing touches the
// network.

import test from "node:test";
import assert from "node:assert/strict";
import { handle } from "../src/index.js";

// ------------------------------------------------------------- fakes

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
  all() { return [...this.map.entries()]; }
}

function makeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler ? handler(url, init) : new Response(null, { status: 201 });
  };
  fn.calls = calls;
  return fn;
}

let keys = null;
async function keyPair() {
  if (!keys) keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return keys;
}
async function publicKeyB64() {
  const { publicKey } = await keyPair();
  return Buffer.from(await crypto.subtle.exportKey("raw", publicKey)).toString("base64");
}
async function sign(body, timestamp) {
  const { privateKey } = await keyPair();
  const data = new TextEncoder().encode(timestamp + body);
  const sig = await crypto.subtle.sign("Ed25519", privateKey, data);
  return Buffer.from(sig).toString("hex");
}

async function discordRequest(obj, { badSig = false, noSig = false } = {}) {
  const body = JSON.stringify(obj);
  const timestamp = "1700000000";
  const headers = {};
  if (!noSig) {
    headers["X-Signature-Timestamp"] = timestamp;
    headers["X-Signature-Ed25519"] = badSig ? "aa".repeat(32) : await sign(body, timestamp);
  }
  return new Request("https://worker.local/discord", { method: "POST", body, headers });
}

function uploadRequest({ token, contentLength, filename, body = null } = {}) {
  const headers = {};
  if (token != null) headers["Authorization"] = `Bearer ${token}`;
  if (contentLength != null) headers["Content-Length"] = String(contentLength);
  if (filename != null) headers["X-Filename"] = filename;
  const init = { method: "POST", body: body ?? undefined, headers };
  if (body instanceof ReadableStream) init.duplex = "half";
  return new Request("https://worker.local/upload", init);
}

async function mintToken(env, kv, fetchImpl, id = "42") {
  const res = await handle(await discordRequest({
    type: 2,
    data: { name: "token" },
    member: { id },
  }), env, fetchImpl);
  const content = (await res.json()).content;
  const m = content.match(/`(mm_[A-Za-z0-9_-]+)`/);
  assert.ok(m, "token in reply");
  return m[1];
}

function makeEnv(kv, pub, overrides = {}) {
  return {
    TOKENS: kv,
    DISCORD_PUBLIC_KEY: pub,
    GITHUB_TOKEN: "gh_test_token",
    GITHUB_OWNER: "octo",
    GITHUB_REPO: "repo",
    ALLOWED_ORIGIN: "https://pages.example.com",
    UPLOAD_DAILY_LIMIT: "2",
    ...overrides,
  };
}

// ----------------------------------------------------- discord endpoint

test("PING with a valid signature gets PONG", async () => {
  const kv = new FakeKV();
  const res = await handle(await discordRequest({ type: 1 }), makeEnv(kv, await publicKeyB64()), makeFetch());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 1 });
});

test("invalid signature is rejected 401", async () => {
  const res = await handle(await discordRequest({ type: 1 }, { badSig: true }),
    makeEnv(new FakeKV(), await publicKeyB64()), makeFetch());
  assert.equal(res.status, 401);
});

test("missing signature headers are rejected 401", async () => {
  const res = await handle(await discordRequest({ type: 1 }, { noSig: true }),
    makeEnv(new FakeKV(), await publicKeyB64()), makeFetch());
  assert.equal(res.status, 401);
});

test("wrong public key is rejected 401", async () => {
  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const otherPub = Buffer.from(await crypto.subtle.exportKey("raw", other.publicKey)).toString("base64");
  const res = await handle(await discordRequest({ type: 1 }),
    makeEnv(new FakeKV(), otherPub), makeFetch());
  assert.equal(res.status, 401);
});

test("/token mints a token; only the hash is stored; reply is ephemeral", async () => {
  const kv = new FakeKV();
  const fetchImpl = makeFetch();
  const res = await handle(await discordRequest({ type: 2, data: { name: "token" }, member: { id: "42" } }),
    makeEnv(kv, await publicKeyB64()), fetchImpl);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.flags, 64);
  const token = body.content.match(/`(mm_[A-Za-z0-9_-]+)`/)[1];
  assert.ok(token.startsWith("mm_"));

  const vals = kv.all();
  const userKey = vals.find(([k]) => k === "user:42");
  assert.ok(userKey, "user key stored");
  const tokKey = vals.find(([k]) => k === `tok:${userKey[1]}`);
  assert.ok(tokKey, "tok key stored");
  assert.equal(JSON.parse(tokKey[1]).discordId, "42");
  for (const [, v] of vals) assert.ok(!v.includes(token), "plaintext token never in KV");
  assert.equal(fetchImpl.calls.length, 0, "no GitHub calls in the interaction handler");
});

test("a second /token invalidates the first", async () => {
  const kv = new FakeKV();
  const env = makeEnv(kv, await publicKeyB64());
  const fetchImpl = makeFetch();
  const t1 = await mintToken(env, kv, fetchImpl);
  const h1 = (await kv.get("user:42"));
  assert.ok(await kv.get(`tok:${h1}`), "first token live");

  const t2 = await mintToken(env, kv, fetchImpl);
  assert.notEqual(t1, t2);
  assert.equal(await kv.get(`tok:${h1}`), null, "first token revoked");
  const h2 = await kv.get("user:42");
  assert.notEqual(h2, h1);
  assert.ok(await kv.get(`tok:${h2}`), "second token live");
});

test("/token revoke deletes both keys", async () => {
  const kv = new FakeKV();
  const env = makeEnv(kv, await publicKeyB64());
  await mintToken(env, kv, makeFetch());
  const res = await handle(await discordRequest({
    type: 2,
    data: { name: "token", options: [{ type: 2, name: "revoke" }] },
    member: { id: "42" },
  }), env, makeFetch());
  assert.equal(res.status, 200);
  assert.equal(await kv.get("user:42"), null);
});

// -------------------------------------------------------- upload endpoint

test("missing token is 401 before any fetch", async () => {
  const f = makeFetch();
  const res = await handle(uploadRequest(), makeEnv(new FakeKV(), await publicKeyB64()), f);
  assert.equal(res.status, 401);
  assert.equal(f.calls.length, 0);
});

test("wrong token is 401", async () => {
  const kv = new FakeKV();
  const f = makeFetch();
  const res = await handle(uploadRequest({ token: "mm_nope" }), makeEnv(kv, await publicKeyB64()), f);
  assert.equal(res.status, 401);
  assert.equal(f.calls.length, 0);
});

test("a minted token is accepted (not 401)", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
    : new Response(null, { status: 201 }));
  const res = await handle(uploadRequest({
    token, contentLength: 10, filename: "a.zip",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
  }), makeEnv(kv, pub), f);
  assert.equal(res.status, 202);
});

test("missing Content-Length is 411", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch();
  const res = await handle(uploadRequest({ token, filename: "a.zip" }), makeEnv(kv, pub), f);
  assert.equal(res.status, 411);
  assert.equal(f.calls.length, 0);
});

test("over 100 MB is 413 before any GitHub call", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch();
  const res = await handle(uploadRequest({ token, contentLength: 101 * 1024 * 1024, filename: "a.zip" }),
    makeEnv(kv, pub), f);
  assert.equal(res.status, 413);
  assert.match(await res.text(), /100 MB/);
  assert.equal(f.calls.length, 0);
});

test("bad extension is 400", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch();
  const res = await handle(uploadRequest({ token, contentLength: 10, filename: "archive.txt" }),
    makeEnv(kv, pub), f);
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

test("daily quota is 429", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  await kv.put("quota:42", JSON.stringify({ date: new Date().toISOString().slice(0, 10), count: 2 }));
  const f = makeFetch();
  const res = await handle(uploadRequest({ token, contentLength: 10, filename: "a.zip" }),
    makeEnv(kv, pub), f);
  assert.equal(res.status, 429);
  assert.equal(f.calls.length, 0);
});

test("missing inbox release is 503 with a helpful message", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? new Response(null, { status: 404 })
    : new Response(null, { status: 201 }));
  const res = await handle(uploadRequest({
    token, contentLength: 10, filename: "a.zip",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
  }), makeEnv(kv, pub), f);
  assert.equal(res.status, 503);
  assert.match(await res.text(), /workflow/i);
});

test("happy path: streams the same body, right headers, dispatch after, 202", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });
  const req = uploadRequest({
    token, contentLength: 3, filename: "My Mod (v1).zip", body,
  });
  const f = makeFetch((url) => {
    if (url.includes("releases/tags/inbox")) return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    if (url.includes("uploads.github.com")) return new Response(null, { status: 201 });
    if (url.includes("/dispatches")) return new Response(null, { status: 204 });
    throw new Error("unexpected url: " + url);
  });
  const res = await handle(req, makeEnv(kv, pub), f);
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: "queued" });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");

  assert.equal(f.calls.length, 3);
  const [rel, up, disp] = f.calls;
  assert.match(rel.url, /releases\/tags\/inbox$/);
  assert.match(up.url, /uploads\.github\.com\/repos\/octo\/repo\/releases\/7\/assets\?name=/);
  assert.match(up.url, /42__\d+__My-Mod-v1-.zip$/);
  assert.equal(up.init.body, body, "the body is the SAME stream object (not a buffered copy)");
  assert.equal(up.init.headers["Authorization"], "Bearer gh_test_token");
  assert.equal(up.init.headers["Content-Type"], "application/zip");
  assert.equal(up.init.headers["Content-Length"], "3");
  assert.match(disp.url, /api\.github\.com\/repos\/octo\/repo\/actions\/workflows\/process-inbox\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(disp.init.body), { ref: "main" });

  assert.equal(JSON.parse(await kv.get("quota:42")).count, 1, "quota incremented");
});

test("github upload failure is 502 with no dispatch", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) => {
    if (url.includes("releases/tags/inbox")) return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    return new Response(null, { status: 500 });
  });
  const res = await handle(uploadRequest({
    token, contentLength: 10, filename: "a.zip",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
  }), makeEnv(kv, pub), f);
  assert.equal(res.status, 502);
  assert.equal(f.calls.length, 2, "lookup + failed upload, no dispatch");
  assert.ok(!f.calls.some((c) => c.url.includes("/dispatches")), "no dispatch after a failed upload");
  assert.equal(await kv.get("quota:42"), null, "quota not charged on failure");
});

test("CORS preflight answers with the allowed origin and headers", async () => {
  const res = await handle(
    new Request("https://worker.local/upload", { method: "OPTIONS" }),
    makeEnv(new FakeKV(), await publicKeyB64()), makeFetch());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal(res.headers.get("Access-Control-Allow-Headers"), "Authorization, Content-Type, X-Filename");
});
