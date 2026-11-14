// Offline tests for the ModCatalog Worker (node --test, Node 20+).
//
// Fake KV (a Map), injected fetch (records calls), and a generated Ed25519
// keypair stand in for Cloudflare/Discord/Github. Nothing touches the
// network.

import test from "node:test";
import assert from "node:assert/strict";
import { handle, loginLinkUrl } from "../src/index.js";
import {
  sha256Hex, peekLoginCode, mintManualToken, mintLoginCode,
  redeemLoginCode, ASQL,
} from "../src/auth.js";
import { FakeD1 } from "./helpers/fake-d1.js";

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
    return handler ? handler(url, init) : new Response(null, { status: 204 });
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
    member: { id, user: { id, username: "alice" } },
  }), env, fetchImpl);
  assert.equal(res.status, 202, "ACK with no body");
  const cb = fetchImpl.calls.filter((c) => c.url.includes("/interactions/") && c.url.includes("/callback")).at(-1);
  assert.ok(cb, "reply sent via the callback endpoint");
  const content = JSON.parse(cb.init.body).data.content;
  const m = content.match(/(mm_[A-Za-z0-9_-]+)/);
  assert.ok(m, "token in reply");
  return m[1];
}

function makeEnv(kv, pub, overrides = {}) {
  return {
    TOKENS: kv,
    DB: overrides.DB || (kv.DB ||= new FakeD1()),
    DISCORD_PUBLIC_KEY: pub,
    GITHUB_TOKEN: "gh_test_token",
    GITHUB_OWNER: "octo",
    GITHUB_REPO: "repo",
    ALLOWED_ORIGIN: "https://pages.example.com",
    SITE_URL: "https://pages.example.com/",
    UPLOAD_DAILY_BYTES: "2000",
    ...overrides,
  };
}

// ----------------------------------------------------- discord endpoint

test("PING with a valid signature gets PONG via the callback endpoint", async () => {
  const kv = new FakeKV();
  const f = makeFetch();
  const res = await handle(await discordRequest({ type: 1 }), makeEnv(kv, await publicKeyB64()), f);
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "", "ACK has no body");
  const cb = f.calls.find((c) => c.url.includes("/interactions/") && c.url.includes("/callback"));
  assert.ok(cb, "PONG sent via the callback endpoint");
  assert.deepEqual(JSON.parse(cb.init.body), { type: 1 });
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
  const db = new FakeD1();
  const fetchImpl = makeFetch();
  const res = await handle(await discordRequest({ type: 2, data: { name: "token" }, member: { id: "42", user: { id: "42", username: "alice" } } }),
    makeEnv(kv, await publicKeyB64(), { DB: db }), fetchImpl);
  assert.equal(res.status, 202);
  assert.equal(await res.text(), "", "ACK has no body");
  const cb = fetchImpl.calls.find((c) => c.url.includes("/interactions/") && c.url.includes("/callback"));
  const resp = JSON.parse(cb.init.body);
  assert.equal(resp.type, 4, "CHANNEL_MESSAGE_WITH_SOURCE");
  assert.equal(resp.data.flags, 64);
  const token = resp.data.content.match(/(mm_[A-Za-z0-9_-]+)/)[1];
  assert.ok(token.startsWith("mm_"));

  const rows = db.tokenRows();
  assert.equal(rows.length, 1, "one token row");
  assert.equal(rows[0].discord_id, "42");
  assert.equal(rows[0].username, "alice");
  assert.equal(rows[0].kind, "manual");
  assert.equal(rows[0].expires_at, null, "a manual token never expires");
  for (const k of Object.keys(rows[0]))
    assert.ok(!String(rows[0][k]).includes(token), "plaintext token never stored");
  assert.equal(fetchImpl.calls.length, 1, "only the Discord callback call (no GitHub)");
});

test("a second /token invalidates the first", async () => {
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = makeEnv(kv, await publicKeyB64(), { DB: db });
  const fetchImpl = makeFetch();
  const t1 = await mintToken(env, kv, fetchImpl);
  const h1 = await sha256Hex(t1);
  assert.ok(db.tokenRows().some((r) => r.hash === h1), "first token live");

  const t2 = await mintToken(env, kv, fetchImpl);
  assert.notEqual(t1, t2);
  assert.equal(db.tokenRows().find((r) => r.hash === h1), undefined, "first token replaced");
  const h2 = await sha256Hex(t2);
  assert.ok(db.tokenRows().some((r) => r.hash === h2), "second token live");
  assert.equal(db.tokenRows().length, 1, "one row after the replacement");
});

test("guild identity: a member object without a top-level id (nested user.id) is accepted", async () => {
  const kv = new FakeKV();
  const db = new FakeD1();
  const res = await handle(await discordRequest({
    type: 2,
    data: { name: "token" },
    member: { user: { id: "77", username: "bob" }, nick: null, roles: [] }, // no top-level `id`
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), makeFetch());
  assert.equal(res.status, 202);
  assert.ok(db.tokenRows().some((r) => r.discord_id === "77"), "keyed by the nested user id");
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

test("daily byte quota is 429 before any fetch", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  await kv.put("quota:42", JSON.stringify({ date: new Date().toISOString().slice(0, 10), bytes: 1950 }));
  const f = makeFetch();
  const res = await handle(uploadRequest({ token, contentLength: 100, filename: "a.zip" }),
    makeEnv(kv, pub), f);
  assert.equal(res.status, 429);
  assert.match(await res.text(), /GiB\/day/i);
  assert.equal(f.calls.length, 0);
});

// --------------------------------------------------- raw file set mode

test("raw file part: name encodes upload id, file idx and part count", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
    : new Response(null, { status: 201 }));
  const req = uploadRequest({
    token, contentLength: 10, filename: "My Mod.utoc",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
  });
  req.headers.set("X-Upload-Id", "abc-123");
  req.headers.set("X-File-Idx", "2");
  req.headers.set("X-Part-Idx", "1");
  req.headers.set("X-Part-Count", "3");
  const res = await handle(req, makeEnv(kv, pub), f);
  assert.equal(res.status, 202);
  const up = f.calls.find((c) => c.url.includes("uploads.github.com"));
  assert.match(up.url, /42-616c696365__abc-123__f2__p1of3__My-Mod\.utoc$/);
});

test("raw manifest upload: fixed name, strict headers", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
    : new Response(null, { status: 201 }));
  const req = uploadRequest({
    token, contentLength: 10, filename: "manifest.json",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
  });
  req.headers.set("X-Upload-Id", "abc-123");
  req.headers.set("X-File-Idx", "-1");
  req.headers.set("X-Part-Idx", "0");
  req.headers.set("X-Part-Count", "1");
  const res = await handle(req, makeEnv(kv, pub), f);
  assert.equal(res.status, 202);
  const up = f.calls.find((c) => c.url.includes("uploads.github.com"));
  assert.match(up.url, /42-616c696365__abc-123__manifest\.json$/);

  // a manifest with the wrong part headers is rejected
  const bad = uploadRequest({
    token, contentLength: 10, filename: "manifest.json",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
  });
  bad.headers.set("X-Upload-Id", "abc-123");
  bad.headers.set("X-File-Idx", "-1");
  bad.headers.set("X-Part-Idx", "1");
  bad.headers.set("X-Part-Count", "1");
  assert.equal((await handle(bad, makeEnv(kv, pub), makeFetch())).status, 400);
});

test("raw mode: wrong extension, missing headers, bad part index -> 400 before GitHub", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const mk = (h) => {
    const r = uploadRequest({
      token, contentLength: 10, filename: h.filename,
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
    });
    for (const [k, v] of Object.entries(h.headers || {})) r.headers.set(k, v);
    return r;
  };
  const base = { headers: { "X-Upload-Id": "u", "X-File-Idx": "0", "X-Part-Idx": "0", "X-Part-Count": "2" } };
  assert.equal((await handle(mk({ ...base, filename: "archive.txt" }), makeEnv(kv, pub), makeFetch())).status, 400);
  assert.equal((await handle(mk({ filename: "a.pak", headers: { "X-Upload-Id": "u" } }), makeEnv(kv, pub), makeFetch())).status, 400);
  assert.equal((await handle(mk({ ...base, filename: "a.pak", headers: { ...base.headers, "X-Part-Idx": "5" } }), makeEnv(kv, pub), makeFetch())).status, 400);
});

test("raw mode: a .sig file is part of a set (mod-contract/package-spec.md)", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
    : new Response(null, { status: 201 }));
  const req = uploadRequest({
    token, contentLength: 10, filename: "mod.sig",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
  });
  req.headers.set("X-Upload-Id", "abc-123");
  req.headers.set("X-File-Idx", "3");
  req.headers.set("X-Part-Idx", "0");
  req.headers.set("X-Part-Count", "1");
  assert.equal((await handle(req, makeEnv(kv, pub), f)).status, 202);
  assert.match(f.calls.find((c) => c.url.includes("uploads.github.com")).url, /__f3__p0of1__mod\.sig$/);
});

test("raw mode: zip mode still requires .zip and raw mode ignores it", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const r1 = uploadRequest({ token, contentLength: 10, filename: "archive.txt" });
  assert.equal((await handle(r1, makeEnv(kv, pub), makeFetch())).status, 400);
  // the same name is fine in raw mode (it's a .pak)
  const r2 = uploadRequest({
    token, contentLength: 10, filename: "a.pak",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
  });
  r2.headers.set("X-Upload-Id", "u");
  r2.headers.set("X-File-Idx", "0");
  r2.headers.set("X-Part-Idx", "0");
  r2.headers.set("X-Part-Count", "1");
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
    : new Response(null, { status: 201 }));
  assert.equal((await handle(r2, makeEnv(kv, pub), f)).status, 202);
});

// ---------------------------------------- upload sets: .zip + metadata.json

async function setPart({ filename, headers, bytes = 10 }) {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
    : new Response(null, { status: 201 }));
  const req = uploadRequest({
    token, contentLength: bytes, filename,
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }),
  });
  for (const [k, v] of Object.entries(headers)) req.headers.set(k, v);
  const res = await handle(req, makeEnv(kv, pub), f);
  return { res, f, up: f.calls.find((c) => c.url.includes("uploads.github.com")) };
}

const SET = { "X-Upload-Id": "abc-123", "X-File-Idx": "0", "X-Part-Idx": "0", "X-Part-Count": "1" };

test("upload set: a .zip is a set file (name encodes idx and parts)", async () => {
  const { res, up } = await setPart({ filename: "My Pack.zip", headers: SET });
  assert.equal(res.status, 202);
  assert.match(up.url, /42-616c696365__abc-123__f0__p0of1__My-Pack\.zip$/);
});

test("upload set: metadata.json has a fixed name and strict headers", async () => {
  const ok = { ...SET, "X-File-Idx": "-2" };
  const { res, up } = await setPart({ filename: "metadata.json", headers: ok });
  assert.equal(res.status, 202);
  assert.match(up.url, /42-616c696365__abc-123__metadata\.json$/);

  for (const [filename, headers] of [
    ["metadata.json", { ...ok, "X-Part-Idx": "1", "X-Part-Count": "2" }],   // not a single part
    ["metadata.json", { ...ok, "X-Part-Count": "2" }],
    ["other.json", ok],                                                      // wrong name for idx -2
    ["mod.pak", ok],
    ["metadata.json", SET],                                                  // a file index, .json is not a set file
    ["metadata.json", { "X-Upload-Id": "abc-123", "X-File-Idx": "-2" }],     // missing part headers
  ]) {
    const r = await setPart({ filename, headers });
    assert.equal(r.res.status, 400, `${filename} ${JSON.stringify(headers)}`);
    assert.equal(r.up, undefined, "rejected before any GitHub call");
  }
});

test("zip mode (no upload id) still needs a .zip name and is unaffected by set files", async () => {
  const { res } = await setPart({ filename: "mod.pak", headers: {} });
  assert.equal(res.status, 400);
});

test("file names never carry the __ field separator", async () => {
  const { up } = await setPart({ filename: "my__mod___v2.pak", headers: SET });
  assert.match(up.url, /42-616c696365__abc-123__f0__p0of1__my_mod_v2\.pak$/);
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
  assert.match(up.url, /42-616c696365__\d+__My-Mod-v1-.zip$/);
  assert.equal(up.init.body, body, "the body is the SAME stream object (not a buffered copy)");
  assert.equal(up.init.headers["Authorization"], "Bearer gh_test_token");
  assert.equal(up.init.headers["Content-Type"], "application/zip");
  assert.equal(up.init.headers["Content-Length"], "3");
  assert.equal(up.init.headers["User-Agent"], "ModCatalog-Worker", "GitHub requires a User-Agent (403 without)");
  assert.equal(disp.init.headers["User-Agent"], "ModCatalog-Worker");
  assert.match(disp.url, /api\.github\.com\/repos\/octo\/repo\/actions\/workflows\/process-inbox\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(disp.init.body), { ref: "main" });

  assert.equal(JSON.parse(await kv.get("quota:42")).bytes, 3, "quota charged in bytes");
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
  assert.equal(res.headers.get("Access-Control-Allow-Headers"),
    "Authorization, Content-Type, X-Filename, X-Upload-Id, X-File-Idx, X-Part-Idx, X-Part-Count");
});

// ----------------------------------------------- verified author names

test("/token stores the account username, not the display name or nickname", async () => {
  const kv = new FakeKV();
  const db = new FakeD1();
  const res = await handle(await discordRequest({
    type: 2,
    data: { name: "token" },
    member: { nick: "Server Nick", user: { id: "77", username: "carol", global_name: "Carol The Great" } },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), makeFetch());
  assert.equal(res.status, 202);
  assert.deepEqual(
    (({ discord_id, username }) => ({ discordId: discord_id, username }))(db.tokenRows()[0]),
    { discordId: "77", username: "carol" });
});

test("/token in a DM: the username comes from the top-level user object", async () => {
  const kv = new FakeKV();
  const db = new FakeD1();
  const res = await handle(await discordRequest({
    type: 2, data: { name: "token" }, user: { id: "88", username: "dave" },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), makeFetch());
  assert.equal(res.status, 202);
  assert.equal(db.tokenRows()[0].username, "dave");
});

test("/token without a username is refused and mints nothing", async () => {
  const kv = new FakeKV();
  const db = new FakeD1();
  const res = await handle(await discordRequest({
    type: 2, data: { name: "token" }, member: { user: { id: "99" } },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), makeFetch());
  assert.equal(res.status, 400);
  assert.equal(db.tokenRows().length, 0);
});

// ------------------------------------------------- the #mods buttons

test("loginLinkUrl: the code is a URL fragment; the trailing slash is normalized", () => {
  assert.equal(loginLinkUrl("https://pages.example.com/", "lc_x"),
    "https://pages.example.com/#login=lc_x");
  assert.equal(loginLinkUrl("https://pages.example.com", "lc_x"),
    "https://pages.example.com/#login=lc_x");
});

async function clickComponent(customId, memberId, username = "alice") {
  const kv = new FakeKV();
  const db = new FakeD1();
  const fetchImpl = makeFetch();
  const res = await handle(await discordRequest({
    type: 3, data: { custom_id: customId },
    member: { user: { id: memberId, username } },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), fetchImpl);
  return { res, db, fetchImpl };
}

test("mods_upload: 202, one callback with an ephemeral link button; the code is valid", async () => {
  const { res, db, fetchImpl } = await clickComponent("mods_upload", "42");
  assert.equal(res.status, 202);
  assert.equal(fetchImpl.calls.length, 1, "only the Discord callback call");
  const cb = fetchImpl.calls[0];
  assert.ok(cb.url.includes("/interactions/") && cb.url.includes("/callback"));
  const resp = JSON.parse(cb.init.body);
  assert.equal(resp.type, 4, "CHANNEL_MESSAGE_WITH_SOURCE");
  assert.equal(resp.data.flags, 64, "ephemeral");
  assert.ok(resp.data.content.includes("works once"), "the copy explains the one-time link");
  assert.equal(resp.data.components.length, 1, "one action row");
  const [button] = resp.data.components[0].components;
  assert.equal(button.type, 2);
  assert.equal(button.style, 5, "link button");
  assert.equal(button.label, "Open the uploader");
  assert.ok(button.url.startsWith("https://pages.example.com/#login=lc_"), `url: ${button.url}`);
  const code = button.url.slice("https://pages.example.com/#login=".length);
  assert.equal(db.codeRows().length, 1, "one code row");
  assert.ok(!String(db.codeRows()[0].hash).includes(code), "only the hash is stored");
  const peek = await peekLoginCode(db, code, new Date());
  assert.equal(peek.ok, true, "the minted code is valid via peekLoginCode");
  assert.equal(peek.discordId, "42");
  assert.equal(peek.username, "alice");
});

test("mods_upload: a missing username is an ephemeral error and mints nothing", async () => {
  const kv = new FakeKV();
  const db = new FakeD1();
  const fetchImpl = makeFetch();
  const res = await handle(await discordRequest({
    type: 3, data: { custom_id: "mods_upload" }, member: { user: { id: "99" } },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), fetchImpl);
  assert.equal(res.status, 202);
  const cb = fetchImpl.calls[0];
  const resp = JSON.parse(cb.init.body);
  assert.equal(resp.data.flags, 64, "ephemeral error");
  assert.ok(!resp.data.components, "no link button");
  assert.equal(db.codeRows().length, 0, "nothing minted");
});

test("six rapid clicks: the sixth gets the rate-limit message", async () => {
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = makeEnv(kv, await publicKeyB64(), { DB: db });
  let last;
  for (let i = 1; i <= 6; i++) {
    const f = makeFetch();
    const res = await handle(await discordRequest({
      type: 3, data: { custom_id: "mods_upload" },
      member: { user: { id: "42", username: "alice" } },
    }), env, f);
    assert.equal(res.status, 202, `click ${i} ACKs`);
    last = JSON.parse(f.calls[0].init.body);
  }
  assert.equal(last.data.content, "You're clicking too fast, try again in a minute.");
  assert.ok(!last.data.components, "no link button when limited");
  assert.equal(db.codeRows().length, 5, "exactly five codes were minted");
});

test("mods_signout: deletes every token of the clicker and invalidates unused codes", async () => {
  const kv = new FakeKV();
  const db = new FakeD1();
  const env = makeEnv(kv, await publicKeyB64(), { DB: db });
  // seed state first: a manual + a web token and an unused code for 42,
  // plus another user's manual token (must survive)
  const now = new Date();
  await mintManualToken(db, { discordId: "42", username: "alice", now });
  const seeded = await mintLoginCode(db, { discordId: "42", username: "alice", now });
  const redeemed = await redeemLoginCode(db, seeded.code, now);
  assert.equal(redeemed.ok, true);
  await mintLoginCode(db, { discordId: "42", username: "alice", now }); // one unused code
  await mintManualToken(db, { discordId: "77", username: "bob", now });
  assert.equal(db.tokenRows().length, 3);

  const fetchImpl = makeFetch();
  const res = await handle(await discordRequest({
    type: 3, data: { custom_id: "mods_signout" },
    member: { user: { id: "42", username: "alice" } },
  }), env, fetchImpl);
  assert.equal(res.status, 202);
  const mine = db.tokenRows().filter((r) => r.discord_id === "42");
  assert.equal(mine.length, 0, "all of 42's tokens are gone");
  assert.ok(db.tokenRows().some((r) => r.discord_id === "77" && r.kind === "manual"),
    "the other user's token survives");
  const codeRows = db.codeRows();
  assert.ok(codeRows.length > 0 && codeRows.every((r) => r.used_at),
    "42's unused codes are invalidated");
  // the reply: an ephemeral confirmation, no components
  const cb = fetchImpl.calls[0];
  const resp = JSON.parse(cb.init.body);
  assert.equal(resp.data.flags, 64);
  assert.ok(resp.data.content.includes("Signed out everywhere"));
});

test("forum_* components still reach the forum handler; unknown ones 400", async () => {
  // forum_unknown:123 with no such row: the forum handler's "no longer
  // active" ephemeral reply (a type-2 command would have 400'd instead)
  const kv = new FakeKV();
  const db = new FakeD1();
  const fetchImpl = makeFetch();
  const res = await handle(await discordRequest({
    type: 3, data: { custom_id: "forum_publish:123" },
    member: { user: { id: "42", username: "alice" } },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), fetchImpl);
  assert.equal(res.status, 202);
  const resp = JSON.parse(fetchImpl.calls[0].init.body);
  assert.ok(resp.data.content.includes("no longer active"), "routed to the forum handler");

  for (const customId of ["other_thing", "", null, undefined]) {
    const r = await handle(await discordRequest({
      type: 3, data: customId == null ? {} : { custom_id: customId },
      member: { user: { id: "42", username: "alice" } },
    }), makeEnv(new FakeKV(), await publicKeyB64(), { DB: new FakeD1() }), makeFetch());
    assert.equal(r.status, 400, `custom_id ${String(customId)} is 400`);
  }
});

function whoamiRequest(token, method = "GET") {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request("https://worker.local/whoami", { method, headers });
}

test("GET /whoami: a live token answers its id and username, with CORS", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const f = makeFetch();
  const token = await mintToken(makeEnv(kv, pub), kv, f);
  const res = await handle(whoamiRequest(token), makeEnv(kv, pub), f);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { discordId: "42", username: "alice" });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");
});

test("GET /whoami: no, unknown or revoked token is 401", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const f = makeFetch();
  const env = makeEnv(kv, pub);
  assert.equal((await handle(whoamiRequest(null), env, f)).status, 401);
  assert.equal((await handle(whoamiRequest("mm_nope"), env, f)).status, 401);
  const old = await mintToken(env, kv, f);
  await mintToken(env, kv, f); // a new mint revokes the old token
  const res = await handle(whoamiRequest(old), env, f);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");
  assert.equal(f.calls.filter((c) => !c.url.includes("/callback")).length, 0, "no GitHub calls");
});

test("CORS preflight for /whoami allows GET and the Authorization header", async () => {
  const res = await handle(whoamiRequest(null, "OPTIONS"), makeEnv(new FakeKV(), await publicKeyB64()), makeFetch());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /GET/);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.equal((await handle(whoamiRequest("x", "POST"), makeEnv(new FakeKV(), await publicKeyB64()), makeFetch())).status, 405);
});

test("every inbox asset name is stamped with the hex of the UTF-8 username", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const f0 = makeFetch();
  // an account name with characters sanitizeFilename would mangle and a "__"
  const username = "Zoë__a b";
  const hex = Buffer.from(username, "utf8").toString("hex");
  const res0 = await handle(await discordRequest({
    type: 2, data: { name: "token" }, member: { user: { id: "55", username } },
  }), makeEnv(kv, pub), f0);
  assert.equal(res0.status, 202);
  const token = JSON.parse(f0.calls.find((c) => c.url.includes("/callback")).init.body)
    .data.content.match(/(mm_[A-Za-z0-9_-]+)/)[1];

  const names = [];
  const f = makeFetch((url) => {
    if (url.includes("/releases/tags/inbox")) return Response.json({ id: 7 });
    if (url.includes("uploads.github.com")) names.push(new URL(url).searchParams.get("name"));
    return new Response(null, { status: 204 });
  });
  const base = { Authorization: `Bearer ${token}`, "Content-Length": "2" };
  const send = (headers) => handle(new Request("https://worker.local/upload", {
    method: "POST", body: "{}", headers: { ...base, ...headers },
  }), makeEnv(kv, pub), f);
  assert.equal((await send({ "X-Filename": "pack.zip" })).status, 202);
  assert.equal((await send({ "X-Upload-Id": "u1", "X-Filename": "manifest.json", "X-File-Idx": "-1", "X-Part-Idx": "0", "X-Part-Count": "1" })).status, 202);
  assert.equal((await send({ "X-Upload-Id": "u1", "X-Filename": "metadata.json", "X-File-Idx": "-2", "X-Part-Idx": "0", "X-Part-Count": "1" })).status, 202);
  assert.equal((await send({ "X-Upload-Id": "u1", "X-Filename": "a.pak", "X-File-Idx": "0", "X-Part-Idx": "0", "X-Part-Count": "1" })).status, 202);
  assert.equal(names.length, 4);
  for (const n of names) {
    assert.ok(n.startsWith(`55-${hex}__`), n);
    assert.equal(n.split("__").length >= 3, true);
  }
  assert.match(names[0], /^55-[0-9a-f]+__\d+__pack\.zip$/);
  assert.match(names[1], /__u1__manifest\.json$/);
  assert.match(names[2], /__u1__metadata\.json$/);
  assert.match(names[3], /__u1__f0__p0of1__a\.pak$/);
});

test("the client cannot choose the stamped name: no header is read for it", async () => {
  const kv = new FakeKV();
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  let name = null;
  const f = makeFetch((url) => {
    if (url.includes("/releases/tags/inbox")) return Response.json({ id: 7 });
    if (url.includes("uploads.github.com")) name = new URL(url).searchParams.get("name");
    return new Response(null, { status: 204 });
  });
  await handle(new Request("https://worker.local/upload", {
    method: "POST", body: "{}",
    headers: { Authorization: `Bearer ${token}`, "Content-Length": "2", "X-Filename": "p.zip",
      "X-Username": "mallory", "X-Discord-Id": "1" },
  }), makeEnv(kv, pub), f);
  assert.match(name, /^42-616c696365__/);
});
