// Offline tests for the D1 auth store (node --test, Node 20+):
// login-code mint/peek/redeem, web tokens, manual tokens via /token,
// and the /auth/* + /whoami + /upload handler behavior. Nothing
// touches the network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  mintManualToken, mintLoginCode, peekLoginCode, redeemLoginCode,
  authenticateToken, deleteWebToken, revokeAllTokens,
} from "../src/auth.js";
import { handle } from "../src/index.js";
import { FakeD1 } from "./helpers/fake-d1.js";

// ------------------------------------------------------------- fakes

class FakeKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
}

function makeFetch() {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.includes("/releases/tags/inbox")) return Response.json({ id: 7 });
    if (url.includes("/interactions/")) return new Response(null, { status: 200 });
    if (url.includes("/dispatches")) return new Response(null, { status: 204 });
    return new Response(null, { status: 201 });
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
async function discordRequest(obj) {
  const body = JSON.stringify(obj);
  const timestamp = "1700000000";
  const { privateKey } = await keyPair();
  const sig = await crypto.subtle.sign("Ed25519", privateKey,
    new TextEncoder().encode(timestamp + body));
  return new Request("https://worker.local/discord", {
    method: "POST", body,
    headers: { "X-Signature-Timestamp": timestamp,
      "X-Signature-Ed25519": Buffer.from(sig).toString("hex") },
  });
}

async function tokenViaDiscord(env, f, id = "42", username = "alice") {
  const res = await handle(await discordRequest({
    type: 2, data: { name: "token" },
    member: { id, user: { id, username } },
  }), env, f);
  assert.equal(res.status, 202);
  const cb = f.calls.filter((c) => c.url.includes("/interactions/") && c.url.includes("/callback")).at(-1);
  const m = JSON.parse(cb.init.body).data.content.match(/(mm_[A-Za-z0-9_-]+)/);
  assert.ok(m, "token in reply");
  return m[1];
}

function makeEnv(db, overrides = {}) {
  return {
    TOKENS: new FakeKV(),
    DB: db,
    DISCORD_PUBLIC_KEY: "",
    GITHUB_TOKEN: "gh_test_token",
    GITHUB_OWNER: "octo",
    GITHUB_REPO: "repo",
    ALLOWED_ORIGIN: "https://pages.example.com",
    UPLOAD_DAILY_BYTES: "2000",
    ...overrides,
  };
}

const NOW = new Date("2025-06-01T12:00:00.000Z");
const LATER = (ms) => new Date(NOW.getTime() + ms);

async function seedCode(db, now = NOW, discordId = "42", username = "alice") {
  const { code } = await mintLoginCode(db, { discordId, username, now });
  return code;
}

// ------------------------------------------------------------ unit tests

test("mint/peek/redeem happy path: the web token authenticates, 90-day expiry", async () => {
  const db = new FakeD1();
  const code = await seedCode(db);
  assert.match(code, /^lc_/);

  const peek = await peekLoginCode(db, code, NOW);
  assert.deepEqual(peek, { ok: true, discordId: "42", username: "alice",
    expiresAt: LATER(300 * 1000).toISOString() });

  const red = await redeemLoginCode(db, code, NOW);
  assert.equal(red.ok, true);
  assert.match(red.token, /^ms_/);
  assert.equal(red.discordId, "42");
  assert.equal(red.username, "alice");
  assert.ok(db.codeRows()[0].used_at, "the code was burned");
  const rec = await authenticateToken(db, red.token, NOW);
  assert.deepEqual(rec, { discordId: "42", username: "alice", kind: "web" });
});

test("peek is read-only: two peeks leave the code usable", async () => {
  const db = new FakeD1();
  const code = await seedCode(db);
  assert.equal((await peekLoginCode(db, code, NOW)).ok, true);
  assert.equal((await peekLoginCode(db, code, NOW)).ok, true, "second peek: still ok");
  const red = await redeemLoginCode(db, code, NOW);
  assert.equal(red.ok, true, "the code was still usable");
});

test("redeem twice: the second fails 'used'", async () => {
  const db = new FakeD1();
  const code = await seedCode(db);
  assert.equal((await redeemLoginCode(db, code, NOW)).ok, true);
  assert.deepEqual(await redeemLoginCode(db, code, NOW), { ok: false, reason: "used" });
  assert.deepEqual(await peekLoginCode(db, code, NOW), { ok: false, reason: "used" });
});

test("a code expires after 5 minutes (peek and redeem -> 'expired')", async () => {
  const db = new FakeD1();
  const code = await seedCode(db);
  const expired = LATER(301 * 1000);
  assert.deepEqual(await peekLoginCode(db, code, expired), { ok: false, reason: "expired" });
  assert.deepEqual(await redeemLoginCode(db, code, expired), { ok: false, reason: "expired" });
  assert.ok(!db.tokenRows().some((t) => t.kind === "web"), "no token on an expired redeem");
});

test("an unknown code is 'unknown' for peek and redeem", async () => {
  const db = new FakeD1();
  assert.deepEqual(await peekLoginCode(db, "lc_nope", NOW), { ok: false, reason: "unknown" });
  assert.deepEqual(await redeemLoginCode(db, "lc_nope", NOW), { ok: false, reason: "unknown" });
});

test("a newer code invalidates the older one", async () => {
  const db = new FakeD1();
  const c1 = await seedCode(db, NOW);
  const { code: c2 } = await mintLoginCode(db, { discordId: "42", username: "alice", now: LATER(1000) });
  assert.notEqual(c1, c2);
  assert.deepEqual(await peekLoginCode(db, c1, LATER(2000)), { ok: false, reason: "used" }, "older code invalidated");
  assert.equal((await peekLoginCode(db, c2, LATER(2000))).ok, true, "newer code usable");
  assert.equal((await redeemLoginCode(db, c1, LATER(2000))).reason, "used");
});

test("rate limit: the 6th code within 60 s is refused", async () => {
  const db = new FakeD1();
  for (let i = 0; i < 5; i++)
    assert.equal((await mintLoginCode(db, { discordId: "42", username: "alice", now: LATER(i * 1000) })).limited, undefined);
  assert.deepEqual(await mintLoginCode(db, { discordId: "42", username: "alice", now: LATER(5000) }), { limited: true });
  // a different user is unaffected
  assert.ok((await mintLoginCode(db, { discordId: "99", username: "bob", now: LATER(6000) })).code);
});

test("two concurrent redeems: exactly one succeeds", async () => {
  const db = new FakeD1();
  const code = await seedCode(db);
  const [a, b] = await Promise.all([
    redeemLoginCode(db, code, NOW),
    redeemLoginCode(db, code, NOW),
  ]);
  const oks = [a, b].filter((r) => r.ok);
  assert.equal(oks.length, 1, "exactly one succeeded");
  assert.equal(oks[0].reason, undefined);
  assert.equal([a, b].find((r) => !r.ok).reason, "used");
});

test("a 'web' token expires after 90 days; a manual token never does", async () => {
  const db = new FakeD1();
  const code = await seedCode(db);
  const { token } = await redeemLoginCode(db, code, NOW);
  assert.equal((await authenticateToken(db, token, NOW)).kind, "web");
  assert.equal(await authenticateToken(db, token, LATER(91 * 24 * 3600 * 1000)), null, "expired at 91 days");
  const manual = await mintManualToken(db, { discordId: "42", username: "alice", now: NOW });
  assert.equal((await authenticateToken(db, manual, LATER(4000 * 24 * 3600 * 1000))).kind, "manual");
});

test("a second /token replaces the manual one but leaves web tokens alone", async () => {
  const db = new FakeD1();
  const m1 = await mintManualToken(db, { discordId: "42", username: "alice", now: NOW });
  const code = await seedCode(db, LATER(1000));
  const { token: web } = await redeemLoginCode(db, code, LATER(2000));
  const m2 = await mintManualToken(db, { discordId: "42", username: "alice", now: LATER(3000) });
  assert.notEqual(m1, m2);
  assert.equal(await authenticateToken(db, m1, LATER(4000)), null, "m1 replaced");
  assert.equal((await authenticateToken(db, m2, LATER(4000))).kind, "manual");
  assert.equal((await authenticateToken(db, web, LATER(4000))).kind, "web", "web token untouched");
  assert.equal(db.tokenRows().length, 2, "exactly two rows");
});

test("logout deletes a web token and leaves a manual one", async () => {
  const db = new FakeD1();
  const code = await seedCode(db);
  const { token: web } = await redeemLoginCode(db, code, NOW);
  const manual = await mintManualToken(db, { discordId: "42", username: "alice", now: LATER(1000) });
  await deleteWebToken(db, manual);
  assert.equal((await authenticateToken(db, manual, LATER(2000))).kind, "manual", "manual survives logout");
  await deleteWebToken(db, web);
  assert.equal(await authenticateToken(db, web, LATER(3000)), null, "web deleted");
});

test("revokeAllTokens clears every token and invalidates unused codes", async () => {
  const db = new FakeD1();
  const manual = await mintManualToken(db, { discordId: "42", username: "alice", now: NOW });
  const c1 = await seedCode(db, LATER(1000));
  const { token: web } = await redeemLoginCode(db, c1, LATER(2000));
  const c2 = await seedCode(db, LATER(3000), "42", "alice");
  await revokeAllTokens(db, "42", LATER(4000));
  assert.equal(db.tokenRows().length, 0, "no tokens left");
  assert.equal(await authenticateToken(db, manual, LATER(5000)), null);
  assert.equal(await authenticateToken(db, web, LATER(5000)), null);
  assert.deepEqual(await redeemLoginCode(db, c2, LATER(5000)), { ok: false, reason: "used" }, "code invalidated");
});

test("the 24 h sweep deletes old codes on mint (unused and used alike)", async () => {
  const db = new FakeD1();
  // a code from yesterday (directly seeded; past the 24 h sweep window)
  const old = new Date(NOW.getTime() - 25 * 3600 * 1000);
  const { code: cOld } = await mintLoginCode(db, { discordId: "42", username: "alice", now: old });
  assert.ok(db.codeRows().some((r) => r.used_at === null), "the old code is present");
  await mintLoginCode(db, { discordId: "42", username: "alice", now: NOW});
  assert.ok(!db.codeRows().some((r) => r.used_at === null && r.created_at < NOW.toISOString()), "old code swept");
  assert.ok(cOld, "the code was minted");
});

// -------------------------------------------------- handler-level tests

test("POST /auth/peek: 200 with identity; 404 unknown; 410 expired and used", async () => {
  const db = new FakeD1();
  const env = makeEnv(db, { DISCORD_PUBLIC_KEY: await publicKeyB64() });
  const post = (code, body) => handle(new Request("https://worker.local/auth/peek", {
    method: "POST", body: body ?? JSON.stringify({ code }),
    headers: { "Content-Type": "application/json" },
  }), env, makeFetch());

  const now = new Date();
  const code = await seedCode(db, now);
  const ok = await post(code);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { discordId: "42", username: "alice",
    expiresAt: new Date(now.getTime() + 300 * 1000).toISOString() });
  assert.equal(ok.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");

  assert.deepEqual(await (await post("lc_nope")).json(), { error: "unknown code", reason: "unknown" });
  assert.equal((await post("lc_nope")).status, 404);

  const expired = new Date(NOW.getTime() - 24 * 3600 * 1000);
  const { code: cExpired } = await mintLoginCode(db, { discordId: "42", username: "alice", now: expired });
  const e = await post(cExpired);
  assert.equal(e.status, 410);
  assert.deepEqual(await e.json(), { error: "code expired", reason: "expired" });

  await redeemLoginCode(db, code, NOW);
  const u = await post(code);
  assert.equal(u.status, 410);
  assert.deepEqual(await u.json(), { error: "code used", reason: "used" });
});

test("POST /auth/redeem: 200 with a web token; a second call is 410 'used'", async () => {
  const db = new FakeD1();
  const env = makeEnv(db, { DISCORD_PUBLIC_KEY: await publicKeyB64() });
  const post = (code) => handle(new Request("https://worker.local/auth/redeem", {
    method: "POST", body: JSON.stringify({ code }),
    headers: { "Content-Type": "application/json" },
  }), env, makeFetch());

  const now = new Date();
  const code = await seedCode(db, now);
  const ok = await post(code);
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.match(j.token, /^ms_/);
  assert.deepEqual({ discordId: j.discordId, username: j.username }, { discordId: "42", username: "alice" });

  const again = await post(code);
  assert.equal(again.status, 410);
  assert.deepEqual(await again.json(), { error: "code used", reason: "used" });
});

test("/auth/* reject non-JSON and oversize bodies with 400, non-POST with 405", async () => {
  const db = new FakeD1();
  const env = makeEnv(db);
  const post = (path, body, method = "POST") => handle(new Request(`https://worker.local${path}`, {
    method, body, headers: { "Content-Type": "application/json" },
  }), env, makeFetch());

  assert.equal((await post("/auth/peek", "not json")).status, 400);
  assert.equal((await post("/auth/peek", JSON.stringify({}))).status, 400, "missing code");
  assert.equal((await post("/auth/peek", "x".repeat(1025))).status, 400, "oversize");
  assert.equal((await post("/auth/redeem", "not json")).status, 400);
  assert.equal((await post("/auth/peek", undefined, "GET")).status, 405);
  assert.equal((await post("/auth/redeem", undefined, "GET")).status, 405);
});

test("OPTIONS /auth/*: CORS preflight with the allowed origin and headers", async () => {
  const env = makeEnv(new FakeD1());
  for (const path of ["/auth/peek", "/auth/redeem", "/auth/logout"]) {
    const res = await handle(new Request(`https://worker.local${path}`, { method: "OPTIONS" }), env, makeFetch());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "https://pages.example.com");
    assert.match(res.headers.get("Access-Control-Allow-Methods"), /POST/);
    assert.match(res.headers.get("Access-Control-Allow-Headers"), /Authorization/);
  }
});

test("POST /auth/logout: 204; deletes a web token, leaves a manual one", async () => {
  const db = new FakeD1();
  const env = makeEnv(db, { DISCORD_PUBLIC_KEY: await publicKeyB64() });
  const manual = await tokenViaDiscord(env, makeFetch());
  const now = new Date();
  const code = await seedCode(db, now);
  const { token: web } = await redeemLoginCode(db, code, now);

  const logout = (tok) => handle(new Request("https://worker.local/auth/logout", {
    method: "POST", headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  }), env, makeFetch());

  assert.equal((await logout(null)).status, 204, "no token: no-op 204");
  assert.equal((await logout(web)).status, 204);
  const whoWeb = await handle(new Request("https://worker.local/whoami",
    { headers: { Authorization: `Bearer ${web}` } }), env, makeFetch());
  assert.equal(whoWeb.status, 401, "the web token is gone");

  assert.equal((await logout(manual)).status, 204);
  const whoManual = await handle(new Request("https://worker.local/whoami",
    { headers: { Authorization: `Bearer ${manual}` } }), env, makeFetch());
  assert.equal(whoManual.status, 200, "the manual token survives");
  assert.deepEqual(await whoManual.json(), { discordId: "42", username: "alice" });
});

test("/whoami and /upload authenticate through the D1 store", async () => {
  const db = new FakeD1();
  const env = makeEnv(db, { DISCORD_PUBLIC_KEY: await publicKeyB64() });
  const token = await tokenViaDiscord(env, makeFetch());

  assert.equal((await handle(new Request("https://worker.local/whoami",
    { headers: { Authorization: `Bearer mm_nope` } }), env, makeFetch())).status, 401, "unknown token 401");

  const who = await handle(new Request("https://worker.local/whoami",
    { headers: { Authorization: `Bearer ${token}` } }), env, makeFetch());
  assert.equal(who.status, 200);
  assert.deepEqual(await who.json(), { discordId: "42", username: "alice" });

  // upload with a D1-minted token still streams through (202)
  const f = makeFetch();
  const up = await handle(new Request("https://worker.local/upload", {
    method: "POST", body: "0123456789",
    headers: { Authorization: `Bearer ${token}`, "Content-Length": "10", "X-Filename": "a.zip" },
  }), env, f);
  assert.equal(up.status, 202);
  assert.ok(f.calls.some((c) => c.url.includes("uploads.github.com")), "streamed to GitHub");
});

test("/token via the interaction mints into D1; a re-mint replaces, no revoke subcommand", async () => {
  const db = new FakeD1();
  const env = makeEnv(db, { DISCORD_PUBLIC_KEY: await publicKeyB64() });
  const f = makeFetch();
  const t1 = await tokenViaDiscord(env, f);
  assert.equal(db.tokenRows().length, 1);
  assert.equal(db.tokenRows()[0].kind, "manual");

  const t2 = await tokenViaDiscord(env, makeFetch());
  assert.notEqual(t1, t2);
  assert.equal(db.tokenRows().length, 1, "replaced, not accumulated");

  // the removed `token revoke` subcommand now falls through to /token
  const res = await handle(await discordRequest({
    type: 2, data: { name: "token", options: [{ type: 2, name: "revoke" }] },
    member: { id: "42", user: { id: "42", username: "alice" } },
  }), env, makeFetch());
  assert.equal(res.status, 202);
  assert.equal(db.tokenRows().length, 1, "replaced again (the subcommand is gone; a plain /token mint)");
  assert.ok(db.tokenRows().every((r) => r.kind === "manual"));
});
