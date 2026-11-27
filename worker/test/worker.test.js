// Offline tests for the ModCatalog Worker (node --test, Node 20+).
//
// A fake D1, injected fetch (records calls), and a generated Ed25519
// keypair stand in for Cloudflare/Discord/Github. Nothing touches the
// network.

import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker, { handle, loginLinkUrl, clearInboxCache } from "../src/index.js";
import { scheduleDelete, sweepDue } from "../src/ephemeral.js";
import { recordWaiting } from "../src/uploads.js";
import {
  sha256Hex, mintManualToken, mintLoginCode,
  redeemLoginCode, ASQL,
} from "../src/auth.js";
import { FakeD1 } from "./helpers/fake-d1.js";

// ------------------------------------------------------------- fakes

beforeEach(() => clearInboxCache());

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
  assert.equal(res.status, 200, "the reply is the response itself");
  const content = (await res.json()).data.content;
  const m = content.match(/(mm_[A-Za-z0-9_-]+)/);
  assert.ok(m, "token in reply");
  return m[1];
}

// `kv` is a per-test holder whose `DB` is the shared fake D1.
function makeEnv(kv, pub, overrides = {}) {
  return {
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

test("PING with a valid signature gets PONG as the response body", async () => {
  const f = makeFetch();
  const res = await handle(await discordRequest({ type: 1 }), makeEnv({}, await publicKeyB64()), f);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await res.json(), { type: 1 });
  assert.equal(f.calls.length, 0, "no outbound calls");
});

test("invalid signature is rejected 401", async () => {
  const res = await handle(await discordRequest({ type: 1 }, { badSig: true }),
    makeEnv({}, await publicKeyB64()), makeFetch());
  assert.equal(res.status, 401);
});

test("missing signature headers are rejected 401", async () => {
  const res = await handle(await discordRequest({ type: 1 }, { noSig: true }),
    makeEnv({}, await publicKeyB64()), makeFetch());
  assert.equal(res.status, 401);
});

test("wrong public key is rejected 401", async () => {
  const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const otherPub = Buffer.from(await crypto.subtle.exportKey("raw", other.publicKey)).toString("base64");
  const res = await handle(await discordRequest({ type: 1 }),
    makeEnv({}, otherPub), makeFetch());
  assert.equal(res.status, 401);
});

test("/token mints a token; only the hash is stored; reply is ephemeral", async () => {
  const kv = {};
  const db = new FakeD1();
  const fetchImpl = makeFetch();
  const res = await handle(await discordRequest({ type: 2, data: { name: "token" }, member: { id: "42", user: { id: "42", username: "alice" } } }),
    makeEnv(kv, await publicKeyB64(), { DB: db }), fetchImpl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json");
  const resp = await res.json();
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
  assert.equal(fetchImpl.calls.length, 0, "no outbound calls");
});

test("a second /token invalidates the first", async () => {
  const kv = {};
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
  const kv = {};
  const db = new FakeD1();
  const res = await handle(await discordRequest({
    type: 2,
    data: { name: "token" },
    member: { user: { id: "77", username: "bob" }, nick: null, roles: [] }, // no top-level `id`
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), makeFetch());
  assert.equal(res.status, 200);
  assert.ok(db.tokenRows().some((r) => r.discord_id === "77"), "keyed by the nested user id");
});

// -------------------------------------------------------- upload endpoint

test("missing token is 401 before any fetch", async () => {
  const f = makeFetch();
  const res = await handle(uploadRequest(), makeEnv({}, await publicKeyB64()), f);
  assert.equal(res.status, 401);
  assert.equal(f.calls.length, 0);
});

test("wrong token is 401", async () => {
  const kv = {};
  const f = makeFetch();
  const res = await handle(uploadRequest({ token: "mm_nope" }), makeEnv(kv, await publicKeyB64()), f);
  assert.equal(res.status, 401);
  assert.equal(f.calls.length, 0);
});

test("a minted token is accepted (not 401)", async () => {
  const kv = {};
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
  const kv = {};
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch();
  const res = await handle(uploadRequest({ token, filename: "a.zip" }), makeEnv(kv, pub), f);
  assert.equal(res.status, 411);
  assert.equal(f.calls.length, 0);
});

test("over 100 MB is 413 before any GitHub call", async () => {
  const kv = {};
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
  const kv = {};
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch();
  const res = await handle(uploadRequest({ token, contentLength: 10, filename: "archive.txt" }),
    makeEnv(kv, pub), f);
  assert.equal(res.status, 400);
  assert.equal(f.calls.length, 0);
});

const TODAY = () => new Date().toISOString().slice(0, 10);

test("daily byte quota is 429 before any fetch", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub);
  const token = await mintToken(env, kv, makeFetch());
  env.DB.quota.set("42", { discord_id: "42", day: TODAY(), bytes: 1950 });
  const f = makeFetch();
  const res = await handle(uploadRequest({ token, contentLength: 100, filename: "a.zip" }), env, f);
  assert.equal(res.status, 429);
  assert.match(await res.text(), /GiB\/day/i);
  assert.equal(f.calls.length, 0);
  assert.equal(env.DB.quotaRow("42").bytes, 1950, "a refused upload charges nothing");
});

test("quota: a row from an earlier day restarts at zero", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub);
  const token = await mintToken(env, kv, makeFetch());
  env.DB.quota.set("42", { discord_id: "42", day: "2000-01-01", bytes: 1999 });
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? Response.json({ id: 7 }) : new Response(null, { status: 201 }));
  const res = await handle(uploadRequest({
    token, contentLength: 10, filename: "a.zip",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
  }), env, f);
  assert.equal(res.status, 202);
  assert.deepEqual(env.DB.quotaRow("42"), { discord_id: "42", day: TODAY(), bytes: 10 });
});

test("quota: a single upload larger than the whole allowance is 429", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub);
  const token = await mintToken(env, kv, makeFetch());
  const f = makeFetch();
  const res = await handle(uploadRequest({ token, contentLength: 2001, filename: "a.zip" }), env, f);
  assert.equal(res.status, 429);
  assert.equal(env.DB.quotaRow("42"), null);
  assert.equal(f.calls.length, 0);
});

test("quota: uploads add up and the one that would overflow is refused", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub);
  const token = await mintToken(env, kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? Response.json({ id: 7 }) : new Response(null, { status: 201 }));
  const send = (n) => handle(uploadRequest({
    token, contentLength: n, filename: "a.zip",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(n)); c.close(); } }),
  }), env, f);
  assert.equal((await send(1200)).status, 202);
  assert.equal((await send(800)).status, 202, "exactly at the limit still fits");
  assert.equal(env.DB.quotaRow("42").bytes, 2000);
  assert.equal((await send(1)).status, 429);
});

test("quota: the charge is refunded when GitHub refuses the upload", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub);
  const token = await mintToken(env, kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? Response.json({ id: 7 }) : new Response(null, { status: 500 }));
  const res = await handle(uploadRequest({
    token, contentLength: 300, filename: "a.zip",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(300)); c.close(); } }),
  }), env, f);
  assert.equal(res.status, 502);
  assert.equal(env.DB.quotaRow("42").bytes, 0, "refunded");
});

test("quota: the charge is refunded when the fetch itself throws", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub);
  const token = await mintToken(env, kv, makeFetch());
  const f = makeFetch((url) => {
    if (url.includes("releases/tags/inbox")) return Response.json({ id: 7 });
    throw new Error("network down");
  });
  const res = await handle(uploadRequest({
    token, contentLength: 300, filename: "a.zip",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(300)); c.close(); } }),
  }), env, f);
  assert.equal(res.status, 502);
  assert.equal(env.DB.quotaRow("42").bytes, 0, "refunded");
});

test("quota: the charge is refunded when the inbox release is missing", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub);
  const token = await mintToken(env, kv, makeFetch());
  const f = makeFetch(() => new Response(null, { status: 404 }));
  const res = await handle(uploadRequest({ token, contentLength: 300, filename: "a.zip" }), env, f);
  assert.equal(res.status, 503);
  assert.equal(env.DB.quotaRow("42").bytes, 0, "refunded");
});

test("the inbox release id is looked up once and then held in memory", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub);
  const token = await mintToken(env, kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? Response.json({ id: 7 }) : new Response(null, { status: 201 }));
  for (let i = 0; i < 3; i++) {
    const res = await handle(uploadRequest({
      token, contentLength: 10, filename: "a.zip",
      body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(10)); c.close(); } }),
    }), env, f);
    assert.equal(res.status, 202);
  }
  assert.equal(f.calls.filter((c) => c.url.includes("releases/tags/inbox")).length, 1);
});

test("/auth/peek is not a route", async () => {
  const res = await handle(new Request("https://worker.local/auth/peek", {
    method: "POST", body: JSON.stringify({ code: "lc_x" }),
  }), makeEnv({}, await publicKeyB64()), makeFetch());
  assert.equal(res.status, 404);
});

test("/catalog/events is not a route", async () => {
  const res = await handle(new Request("https://worker.local/catalog/events", { method: "POST", body: "{}" }),
    makeEnv({}, await publicKeyB64()), makeFetch());
  assert.equal(res.status, 404);
});

// --------------------------------------------------- raw file set mode

test("raw file part: name encodes upload id, file idx and part count", async () => {
  const kv = {};
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
  const kv = {};
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
  assert.deepEqual(await res.json(), { status: "queued" });
  const up = f.calls.find((c) => c.url.includes("uploads.github.com"));
  assert.match(up.url, /42-616c696365__abc-123__manifest\.json$/);
  assert.ok(f.calls.some((c) => c.url.includes("/dispatches")), "the manifest wakes the workflow");

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
  const kv = {};
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
  const kv = {};
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
  const kv = {};
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

// ------------------------------------------------- upload sets: parts + manifest

async function setPart({ filename, headers, bytes = 10 }) {
  const kv = {};
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) => {
    if (url.includes("releases/tags/inbox")) return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    if (url.includes("/dispatches")) return new Response(null, { status: 204 });
    return new Response(null, { status: 201 });
  });
  const req = uploadRequest({
    token, contentLength: bytes, filename,
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } }),
  });
  for (const [k, v] of Object.entries(headers)) req.headers.set(k, v);
  const res = await handle(req, makeEnv(kv, pub), f);
  return { res, f, db: kv.DB, up: f.calls.find((c) => c.url.includes("uploads.github.com")) };
}

const SET = { "X-Upload-Id": "abc-123", "X-File-Idx": "0", "X-Part-Idx": "0", "X-Part-Count": "1" };

test("upload set: a .zip is a set file (name encodes idx and parts)", async () => {
  const { res, up } = await setPart({ filename: "My Pack.zip", headers: SET });
  assert.equal(res.status, 202);
  assert.match(up.url, /42-616c696365__abc-123__f0__p0of1__My-Pack\.zip$/);
});

test("upload set: a part answers stored and does not wake the workflow", async () => {
  const { res, f } = await setPart({ filename: "a.pak", headers: SET });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: "stored" });
  assert.ok(!f.calls.some((c) => c.url.includes("/dispatches")), "no dispatch for a part");
});

test("upload set: the manifest answers queued and wakes the workflow once", async () => {
  const { res, f } = await setPart({
    filename: "manifest.json", headers: { ...SET, "X-File-Idx": "-1" },
  });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { status: "queued" });
  assert.equal(f.calls.filter((c) => c.url.includes("/dispatches")).length, 1);
});

test("upload set: there is no metadata upload (X-File-Idx -2 is 400)", async () => {
  const { res, up } = await setPart({
    filename: "metadata.json", headers: { ...SET, "X-File-Idx": "-2" },
  });
  assert.equal(res.status, 400);
  assert.equal(up, undefined, "rejected before any GitHub call");
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
  const kv = {};
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
  const kv = {};
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

  assert.equal(kv.DB.quotaRow("42").bytes, 3, "quota charged in bytes");
});

test("github upload failure is 502 with no dispatch", async () => {
  const kv = {};
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
  assert.equal(kv.DB.quotaRow("42").bytes, 0, "quota refunded on failure");
});

test("CORS preflight answers with the allowed origin and headers", async () => {
  const res = await handle(
    new Request("https://worker.local/upload", { method: "OPTIONS" }),
    makeEnv({}, await publicKeyB64()), makeFetch());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");
  assert.equal(res.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
  assert.equal(res.headers.get("Access-Control-Allow-Headers"),
    "Authorization, Content-Type, X-Filename, X-Upload-Id, X-File-Idx, X-Part-Idx, X-Part-Count");
});

// ----------------------------------------------- verified author names

test("/token stores the account username, not the display name or nickname", async () => {
  const kv = {};
  const db = new FakeD1();
  const res = await handle(await discordRequest({
    type: 2,
    data: { name: "token" },
    member: { nick: "Server Nick", user: { id: "77", username: "carol", global_name: "Carol The Great" } },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), makeFetch());
  assert.equal(res.status, 200);
  assert.deepEqual(
    (({ discord_id, username }) => ({ discordId: discord_id, username }))(db.tokenRows()[0]),
    { discordId: "77", username: "carol" });
});

test("/token in a DM: the username comes from the top-level user object", async () => {
  const kv = {};
  const db = new FakeD1();
  const res = await handle(await discordRequest({
    type: 2, data: { name: "token" }, user: { id: "88", username: "dave" },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), makeFetch());
  assert.equal(res.status, 200);
  assert.equal(db.tokenRows()[0].username, "dave");
});

test("/token without a username is refused and mints nothing", async () => {
  const kv = {};
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
  const kv = {};
  const db = new FakeD1();
  const fetchImpl = makeFetch();
  const res = await handle(await discordRequest({
    type: 3, data: { custom_id: customId },
    member: { user: { id: memberId, username } },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), fetchImpl);
  return { res, db, fetchImpl };
}

test("mods_upload: 200 with an ephemeral link button; the code is valid", async () => {
  const { res, db, fetchImpl } = await clickComponent("mods_upload", "42");
  assert.equal(res.status, 200);
  assert.equal(fetchImpl.calls.length, 0, "no outbound calls");
  const resp = await res.json();
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
  const red = await redeemLoginCode(db, code, new Date());
  assert.equal(red.ok, true, "the minted code redeems");
  assert.equal(red.discordId, "42");
  assert.equal(red.username, "alice");
});

test("mods_upload: a missing username is an ephemeral error and mints nothing", async () => {
  const kv = {};
  const db = new FakeD1();
  const fetchImpl = makeFetch();
  const res = await handle(await discordRequest({
    type: 3, data: { custom_id: "mods_upload" }, member: { user: { id: "99" } },
  }), makeEnv(kv, await publicKeyB64(), { DB: db }), fetchImpl);
  assert.equal(res.status, 200);
  const resp = await res.json();
  assert.equal(resp.type, 4, "an ephemeral reply, not a defer (a type-7 response would EDIT the public message)");
  assert.equal(resp.data.flags, 64, "ephemeral error");
  assert.ok(!resp.data.components, "no link button");
  assert.equal(db.codeRows().length, 0, "nothing minted");
});

test("six rapid clicks: the sixth gets the rate-limit message", async () => {
  const kv = {};
  const db = new FakeD1();
  const env = makeEnv(kv, await publicKeyB64(), { DB: db });
  let last;
  for (let i = 1; i <= 6; i++) {
    const f = makeFetch();
    const res = await handle(await discordRequest({
      type: 3, data: { custom_id: "mods_upload" },
      member: { user: { id: "42", username: "alice" } },
    }), env, f);
    assert.equal(res.status, 200, `click ${i} answers`);
    last = await res.json();
  }
  assert.equal(last.type, 4, "the rate-limit reply is an ephemeral reply (never a message edit)");
  assert.equal(last.data.content, "You're clicking too fast, try again in a minute.");
  assert.ok(!last.data.components, "no link button when limited");
  assert.equal(db.codeRows().length, 5, "exactly five codes were minted");
});

test("mods_signout: deletes every token of the clicker and invalidates unused codes", async () => {
  const kv = {};
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
  assert.equal(res.status, 200);
  const mine = db.tokenRows().filter((r) => r.discord_id === "42");
  assert.equal(mine.length, 0, "all of 42's tokens are gone");
  assert.ok(db.tokenRows().some((r) => r.discord_id === "77" && r.kind === "manual"),
    "the other user's token survives");
  const codeRows = db.codeRows();
  assert.ok(codeRows.length > 0 && codeRows.every((r) => r.used_at),
    "42's unused codes are invalidated");
  // the reply: an ephemeral confirmation, no components
  const resp = await res.json();
  assert.equal(resp.type, 4, "an ephemeral reply, not a defer (a type-7 response would EDIT the public message)");
  assert.equal(resp.data.flags, 64);
  assert.ok(resp.data.content.includes("Signed out everywhere"));
});

test("unknown custom ids 400", async () => {
  for (const customId of ["forum_publish:123", "other_thing", "", null, undefined]) {
    const r = await handle(await discordRequest({
      type: 3, data: customId == null ? {} : { custom_id: customId },
      member: { user: { id: "42", username: "alice" } },
    }), makeEnv({}, await publicKeyB64(), { DB: new FakeD1() }), makeFetch());
    assert.equal(r.status, 400, `custom_id ${String(customId)} is 400`);
  }
});

function whoamiRequest(token, method = "GET") {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new Request("https://worker.local/whoami", { method, headers });
}

test("GET /whoami: a live token answers its id and username, with CORS", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const f = makeFetch();
  const token = await mintToken(makeEnv(kv, pub), kv, f);
  const res = await handle(whoamiRequest(token), makeEnv(kv, pub), f);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { discordId: "42", username: "alice" });
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");
});

test("GET /whoami: no, unknown or revoked token is 401", async () => {
  const kv = {};
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
  assert.equal(f.calls.length, 0, "no GitHub calls");
});

test("CORS preflight for /whoami allows GET and the Authorization header", async () => {
  const res = await handle(whoamiRequest(null, "OPTIONS"), makeEnv({}, await publicKeyB64()), makeFetch());
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");
  assert.match(res.headers.get("Access-Control-Allow-Methods"), /GET/);
  assert.match(res.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  assert.equal((await handle(whoamiRequest("x", "POST"), makeEnv({}, await publicKeyB64()), makeFetch())).status, 405);
});

test("every inbox asset name is stamped with the hex of the UTF-8 username", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const f0 = makeFetch();
  // an account name with characters sanitizeFilename would mangle and a "__"
  const username = "Zoë__a b";
  const hex = Buffer.from(username, "utf8").toString("hex");
  const res0 = await handle(await discordRequest({
    type: 2, data: { name: "token" }, member: { user: { id: "55", username } },
  }), makeEnv(kv, pub), f0);
  assert.equal(res0.status, 200);
  const token = (await res0.json()).data.content.match(/(mm_[A-Za-z0-9_-]+)/)[1];

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
  assert.equal((await send({ "X-Upload-Id": "u1", "X-Filename": "a.pak", "X-File-Idx": "0", "X-Part-Idx": "0", "X-Part-Count": "1" })).status, 202);
  assert.equal(names.length, 3);
  for (const n of names) {
    assert.ok(n.startsWith(`55-${hex}__`), n);
    assert.equal(n.split("__").length >= 3, true);
  }
  assert.match(names[0], /^55-[0-9a-f]+__\d+__pack\.zip$/);
  assert.match(names[1], /__u1__manifest\.json$/);
  assert.match(names[2], /__u1__f0__p0of1__a\.pak$/);
});

test("the client cannot choose the stamped name: no header is read for it", async () => {
  const kv = {};
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

// ------------------------------------------------ ephemeral reply deletion

const APP_ID = "app1";
const member = { id: "42", user: { id: "42", username: "alice" } };

function discordFetch(status = 204) {
  return makeFetch((url) => {
    if (url.startsWith("https://discord.com/")) return new Response(null, { status });
    return new Response(null, { status: 204 });
  });
}

function fakeCtx() {
  const pending = [];
  return { pending, waitUntil: (p) => pending.push(p), settle: () => Promise.all(pending) };
}

async function interact(env, f, ctx, obj) {
  const res = await handle(await discordRequest({ application_id: APP_ID, member, ...obj }), env, f, ctx);
  await ctx.settle();
  return res;
}

const discordDeletes = (f) => f.calls.filter((c) => c.url.startsWith("https://discord.com/"));

test("a reply schedules its own deletion 5 minutes out", async () => {
  const db = new FakeD1();
  const env = makeEnv({}, await publicKeyB64(), { DB: db });
  const f = discordFetch();
  const res = await interact(env, f, fakeCtx(), { type: 3, token: "itok1", data: { custom_id: "mods_signout" } });
  assert.equal(res.status, 200);
  const [row] = db.ephemeralRows();
  assert.equal(row.interaction_token, "itok1");
  assert.equal(row.application_id, APP_ID);
  assert.equal(Date.parse(row.delete_at) - Date.parse(row.created_at), 5 * 60 * 1000);
  assert.equal(discordDeletes(f).length, 0, "nothing is deleted yet");
});

test("the sweep deletes due replies and leaves not-yet-due ones", async () => {
  const db = new FakeD1();
  const t0 = new Date("2026-01-01T00:00:00Z");
  await scheduleDelete(db, { applicationId: APP_ID, token: "early", now: t0 });
  await scheduleDelete(db, { applicationId: APP_ID, token: "late", now: new Date(t0.getTime() + 4 * 60 * 1000) });
  const f = discordFetch();
  await sweepDue(db, f, new Date(t0.getTime() + 5 * 60 * 1000));
  const calls = discordDeletes(f);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].url, `https://discord.com/api/v10/webhooks/${APP_ID}/early/messages/@original`);
  assert.ok(calls[0].init.headers["User-Agent"]);
  assert.deepEqual(db.ephemeralRows().map((r) => r.interaction_token), ["late"]);
});

test("a 404 on delete counts as done; a failure is retried until the token dies", async () => {
  const db = new FakeD1();
  const t0 = new Date("2026-01-01T00:00:00Z");
  await scheduleDelete(db, { applicationId: APP_ID, token: "gone", now: t0 });
  await sweepDue(db, discordFetch(404), new Date(t0.getTime() + 6 * 60 * 1000));
  assert.equal(db.ephemeralRows().length, 0);

  await scheduleDelete(db, { applicationId: APP_ID, token: "flaky", now: t0 });
  await sweepDue(db, discordFetch(500), new Date(t0.getTime() + 6 * 60 * 1000));
  assert.equal(db.ephemeralRows().length, 1, "kept for the next run");
  await sweepDue(db, discordFetch(500), new Date(t0.getTime() + 15 * 60 * 1000));
  assert.equal(db.ephemeralRows().length, 0, "dropped once the interaction token has expired");
});

test("the scheduled handler runs the sweep through waitUntil", async () => {
  const ctx = fakeCtx();
  await worker.scheduled({}, makeEnv({}, await publicKeyB64()), ctx);
  assert.equal(ctx.pending.length, 1);
  await ctx.settle();
});

test("redeeming a login code deletes the login-link reply at once", async () => {
  const db = new FakeD1();
  const env = makeEnv({}, await publicKeyB64(), { DB: db });
  const f = discordFetch();
  const res = await interact(env, f, fakeCtx(), { type: 3, token: "itok2", data: { custom_id: "mods_upload" } });
  const link = (await res.json()).data.components[0].components[0].url;
  const code = link.split("#login=")[1];
  assert.equal(db.ephemeralRows().length, 1);

  const bad = await handle(new Request("https://worker.local/auth/redeem", {
    method: "POST", body: JSON.stringify({ code: "lc_nope" }) }), env, f, fakeCtx());
  assert.equal(bad.status, 404);
  assert.equal(discordDeletes(f).length, 0, "a failed redeem deletes nothing");

  const ctx = fakeCtx();
  const redeem = await handle(new Request("https://worker.local/auth/redeem", {
    method: "POST", body: JSON.stringify({ code }) }), env, f, ctx);
  await ctx.settle();
  assert.equal(redeem.status, 200);
  assert.equal(discordDeletes(f)[0].url, `https://discord.com/api/v10/webhooks/${APP_ID}/itok2/messages/@original`);
  assert.equal(db.ephemeralRows().length, 0);
});

test("the first use of a /token token deletes the /token reply", async () => {
  const db = new FakeD1();
  const env = makeEnv({}, await publicKeyB64(), { DB: db });
  const f = discordFetch();
  const res = await interact(env, f, fakeCtx(), { type: 2, token: "itok3", data: { name: "token" } });
  const token = (await res.json()).data.content.match(/(mm_[A-Za-z0-9_-]+)/)[1];
  assert.equal(db.ephemeralRows().length, 1);

  const ctx = fakeCtx();
  const who = await handle(new Request("https://worker.local/whoami", {
    headers: { Authorization: `Bearer ${token}` } }), env, f, ctx);
  await ctx.settle();
  assert.equal(who.status, 200);
  assert.equal(discordDeletes(f).length, 1);
  assert.equal(db.ephemeralRows().length, 0);
});

// ------------------------------------------------------ upload status

test("a queued zip upload records a waiting row keyed by the asset name without the stamp", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) => {
    if (url.includes("releases/tags/inbox")) return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    return new Response(null, { status: 201 });
  });
  const res = await handle(uploadRequest({
    token, contentLength: 3, filename: "My Mod.zip",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)); c.close(); } }),
  }), makeEnv(kv, pub), f);
  assert.equal(res.status, 202);
  const [row] = kv.DB.uploadRows("42");
  assert.equal(row.status, "waiting");
  assert.equal(row.label, "My Mod.zip");
  assert.match(row.upload_key, /^\d+__My-Mod\.zip$/);
  const up = f.calls.find((c) => c.url.includes("uploads.github.com"));
  assert.ok(decodeURIComponent(up.url).endsWith(`42-616c696365__${row.upload_key}`), "the key is the asset name tail");
  assert.ok(Math.abs(Date.parse(row.uploaded_at) - Date.now()) < 5000);
});

test("a set's manifest records a waiting row keyed by the upload id; its parts do not", async () => {
  const part = await setPart({ filename: "a.pak", headers: SET });
  assert.deepEqual(part.db.uploadRows(), []);
  const manifest = await setPart({ filename: "manifest.json", headers: { ...SET, "X-File-Idx": "-1" } });
  const [row] = manifest.db.uploadRows("42");
  assert.equal(row.upload_key, "abc-123");
  assert.equal(row.status, "waiting");
});

test("a refused upload records nothing", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const token = await mintToken(makeEnv(kv, pub), kv, makeFetch());
  const f = makeFetch((url) =>
    url.includes("releases/tags/inbox") ? new Response(JSON.stringify({ id: 7 }), { status: 200 })
    : new Response(null, { status: 500 }));
  const res = await handle(uploadRequest({
    token, contentLength: 3, filename: "a.zip",
    body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(3)); c.close(); } }),
  }), makeEnv(kv, pub), f);
  assert.equal(res.status, 502);
  assert.deepEqual(kv.DB.uploadRows(), []);
});

function resultsRequest(body, { auth = "Bearer s3cret", method = "POST" } = {}) {
  const headers = {};
  if (auth != null) headers.Authorization = auth;
  return new Request("https://worker.local/uploads/results", {
    method, headers, body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

const WAITING = "INSERT OR IGNORE INTO uploads (discord_id, upload_key, uploaded_at, label, status, updated_at) VALUES (?1, ?2, ?3, ?4, 'waiting', ?3)";

test("/uploads/results: 503 without the secret, 401 for a wrong or missing one", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const report = [{ key: "k", discord_id: "42", status: "published" }];
  assert.equal((await handle(resultsRequest(report), makeEnv(kv, pub), makeFetch())).status, 503);
  const env = makeEnv(kv, pub, { UPLOAD_RESULTS_SECRET: "s3cret" });
  assert.equal((await handle(resultsRequest(report, { auth: "Bearer nope" }), env, makeFetch())).status, 401);
  assert.equal((await handle(resultsRequest(report, { auth: null }), env, makeFetch())).status, 401);
  assert.equal((await handle(resultsRequest(report, { auth: "s3cret" }), env, makeFetch())).status, 401);
  assert.equal((await handle(resultsRequest(null, { method: "GET" }), env, makeFetch())).status, 405);
  assert.deepEqual(kv.DB.uploadRows(), [], "nothing stored without the secret");
});

test("/uploads/results: upserts outcomes onto waiting rows and inserts unknown keys", async () => {
  const kv = {};
  const db = new FakeD1();
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub, { DB: db, UPLOAD_RESULTS_SECRET: "s3cret" });
  await db.prepare(WAITING).bind("42", "k1", "2026-01-01T00:00:00.000Z", "a.zip").run();
  const res = await handle(resultsRequest([
    { key: "k1", discord_id: "42", status: "published", title: "Cool Mod", version: "1.2" },
    { key: "k2", discord_id: "42", status: "rejected", reason: "bad package" },
    { key: "", discord_id: "42", status: "published" },
    { key: "k3", discord_id: "not-a-number", status: "published" },
    { key: "k4", discord_id: "42", status: "waiting" },
  ]), env, makeFetch());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { stored: 2, skipped: 3 });
  const rows = Object.fromEntries(db.uploadRows("42").map((r) => [r.upload_key, r]));
  assert.equal(rows.k1.status, "published");
  assert.equal(rows.k1.title, "Cool Mod");
  assert.equal(rows.k1.version, "1.2");
  assert.equal(rows.k1.uploaded_at, "2026-01-01T00:00:00.000Z", "the upload time is kept");
  assert.equal(rows.k1.label, "a.zip");
  assert.equal(rows.k2.status, "rejected");
  assert.equal(rows.k2.reason, "bad package");
  assert.ok(Math.abs(Date.parse(rows.k2.uploaded_at) - Date.now()) < 5000, "unknown key: now");
});

test("/uploads/results: bad json, a non-list, too many reports and a big body are refused", async () => {
  const kv = {};
  const pub = await publicKeyB64();
  const env = makeEnv(kv, pub, { UPLOAD_RESULTS_SECRET: "s3cret" });
  assert.equal((await handle(resultsRequest("{oops"), env, makeFetch())).status, 400);
  assert.equal((await handle(resultsRequest({ key: "k" }), env, makeFetch())).status, 400);
  const many = Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, discord_id: "42", status: "published" }));
  assert.equal((await handle(resultsRequest(many), env, makeFetch())).status, 400);
  const big = [{ key: "k", discord_id: "42", status: "rejected", reason: "x".repeat(70000) }];
  assert.equal((await handle(resultsRequest(big), env, makeFetch())).status, 413);
});

test("only the newest 20 rows of a user are kept", async () => {
  const db = new FakeD1();
  for (let i = 0; i < 25; i++)
    await recordWaiting(db, { discordId: "42", key: `k${i}`, label: "a.zip", now: new Date(Date.UTC(2026, 0, 1, 0, 0, i)) });
  await recordWaiting(db, { discordId: "7", key: "other", label: "b.zip", now: new Date() });
  const keys = db.uploadRows("42").map((r) => r.upload_key);
  assert.equal(keys.length, 20);
  assert.equal(keys[0], "k24");
  assert.ok(!keys.includes("k4") && keys.includes("k5"));
  assert.equal(db.uploadRows("7").length, 1, "another user's rows are untouched");
});

async function status(db, who = "42") {
  const env = makeEnv({}, await publicKeyB64(), { DB: db });
  const f = discordFetch();
  const res = await interact(env, f, fakeCtx(), {
    type: 3, token: "itok", data: { custom_id: "mods_status" },
    member: { id: who, user: { id: who, username: "alice" } },
  });
  assert.equal(f.calls.filter((c) => !c.url.startsWith("https://discord.com/")).length, 0, "no GitHub calls");
  return { res, body: await res.json() };
}

test("mods_status: nothing uploaded yet", async () => {
  const { res, body } = await status(new FakeD1());
  assert.equal(res.status, 200);
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64, "ephemeral");
  assert.deepEqual(body.data.allowed_mentions, { parse: [] });
  assert.match(body.data.content, /haven't uploaded anything yet/);
});

test("mods_status: the last 3 uploads, newest first, with Discord timestamps and statuses", async () => {
  const db = new FakeD1();
  const rows = [
    ["k1", "2026-01-01T00:00:00.000Z", "old.zip", "published", "Old Mod", "1.0", null],
    ["k2", "2026-01-02T00:00:00.000Z", "b.zip", "published", "Cool Mod", "1.2", null],
    ["k3", "2026-01-03T00:00:00.000Z", "c.zip", "rejected", "Bad @everyone [x](http://e.com) `y`", null,
      "invalid package: no <@1> metadata trailer"],
    ["k4", "2026-01-04T00:00:00.000Z", "mod upload", "waiting", null, null, null],
  ];
  for (const [key, at, label, st, title, version, reason] of rows) {
    await db.prepare(WAITING).bind("42", key, at, label).run();
    Object.assign(db.uploads.get(`42/${key}`), { status: st, title, version, reason });
  }
  await db.prepare(WAITING).bind("99", "theirs", "2026-01-05T00:00:00.000Z", "x.zip").run();
  const { body } = await status(db);
  const text = body.data.content;
  const ts = (iso) => Math.floor(Date.parse(iso) / 1000);
  assert.match(text, /^\*\*Your last 3 uploads\*\*\n1\. /);
  const i4 = text.indexOf(`<t:${ts("2026-01-04T00:00:00.000Z")}:f>`);
  const i3 = text.indexOf(`<t:${ts("2026-01-03T00:00:00.000Z")}:f>`);
  const i2 = text.indexOf(`<t:${ts("2026-01-02T00:00:00.000Z")}:f>`);
  assert.ok(i4 > -1 && i4 < i3 && i3 < i2, "newest first");
  assert.ok(text.includes(`<t:${ts("2026-01-04T00:00:00.000Z")}:R>`));
  assert.ok(!text.includes("Old Mod") && !text.includes("x.zip"), "only the last 3 of the clicker");
  assert.match(text, /\*\*mod upload\*\*: ⏳ Waiting to be processed/);
  assert.match(text, /\*\*Cool Mod\*\* v1\.2: ✅ Published \(<https:\/\/pages\.example\.com\/>\)/);
  assert.match(text, /❌ Rejected: invalid package: no 1 metadata trailer/);
  assert.ok(!text.includes("@") && !text.includes("<@") && !text.includes("](http"), "user text is neutralized");
  assert.ok(text.length <= 2000);
});

test("mods_status: one upload reads singular", async () => {
  const db = new FakeD1();
  await db.prepare(WAITING).bind("42", "k", "2026-01-01T00:00:00.000Z", "a.zip").run();
  const { body } = await status(db);
  assert.match(body.data.content, /^\*\*Your last upload\*\*/);
  assert.match(body.data.content, /\*\*a\.zip\*\*: ⏳/);
});
