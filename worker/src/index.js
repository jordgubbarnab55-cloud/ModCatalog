// ModCatalog Worker: Discord interactions (token minting) + streaming upload
// API. Plain JS ES module, zero dependencies.
//
// Everything that talks to a service is injectable: the handler takes `env`
// (D1 binding + secrets + vars) and a `fetch` function, so tests can supply
// fakes. The Worker never stores file bytes: the upload body is streamed
// straight through to GitHub releases (no buffering, no cold storage).
//
// Every inbox asset name starts with the uploader stamp (uploaderStamp).
// Two upload shapes:
//   * zip packages: X-Filename <name>.zip, one upload per package, no upload id
//   * upload sets: either the loose .utoc/.ucas/.pak(/.sig) files or exactly
//     one .zip (part-split when over 100 MB), then a manifest.json upload
//     last, all tagged with the same X-Upload-Id; the workflow reassembles,
//     applies the manifest's metadata and zips on the runner (this Worker
//     cannot: 10 ms CPU, stateless).
import {
  authenticateToken, mintManualToken, sha256Hex,
  redeemLoginCode, deleteWebToken, mintLoginCode, revokeAllTokens,
} from "./auth.js";
import { chargeQuota, refundQuota } from "./quota.js";
import { scheduleDelete, deleteLinkedReplies, sweepDue } from "./ephemeral.js";
import {
  recordWaiting, validReport, storeResults, recentUploads, statusMessage,
  MAX_RESULTS, MAX_RESULTS_BODY,
} from "./uploads.js";

const MAX_BODY_BYTES = 100 * 1024 * 1024; // Cloudflare free-plan request-body limit
const DEFAULT_DAILY_BYTES = 2147483648; // 2 GiB of uploads per user per UTC day
const RAW_EXTENSIONS = [".pak", ".ucas", ".utoc", ".sig", ".zip"];
// The X-File-Idx of an upload set's manifest (every other index is a file).
const MANIFEST_IDX = "-1";
const INBOX_TAG = "inbox";
const INBOX_WAKE_WORKFLOW = "process-inbox.yml";
// GitHub's API rejects requests without a User-Agent (403 "administrative
// rules"); the Worker's fetch sends none by default.
const GITHUB_UA = "ModCatalog-Worker";

// The inbox release id per `owner/repo`, held in isolate memory; a miss
// is looked up from GitHub.
const inboxReleaseIds = new Map();

export function clearInboxCache() {
  inboxReleaseIds.clear();
}

// ---------------------------------------------------------------- helpers

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

// "__" separates the fields of an inbox asset name, so a file name never
// carries one.
function sanitizeFilename(name) {
  return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/_{2,}/g, "_")
    .replace(/^-+|-+$/g, "");
}

async function verifyDiscordSignature(publicKeyB64, timestamp, rawBody, signatureHex) {
  if (!timestamp || !signatureHex) return false;
  try {
    const keyBytes = Uint8Array.from(atob(publicKeyB64), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      "raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    const data = new TextEncoder().encode(timestamp + rawBody);
    const sig = Uint8Array.from(
      signatureHex.match(/.{1,2}/g).map((h) => parseInt(h, 16)));
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, data);
  } catch {
    return false;
  }
}

// The uploader as the pipeline learns it: an inbox asset name starts with
// `<discordId>-<hex of the UTF-8 username>`, so the username survives
// sanitizeFilename and the "__" field split and never comes from the client.
export function uploaderStamp(discordId, username) {
  const hex = [...new TextEncoder().encode(username)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${discordId}-${hex}`;
}

// The identity of an interaction (type 2 command or type 3 component).
// The current Discord member object has NO top-level id — the user id is
// nested at member.user.id (member.id and the DM user.id are fallbacks for
// other payload variants). The username is the Discord account name (not
// the display name, not the server nickname).
export function interactionUser(body) {
  const discordId =
    (body.member && (body.member.id || (body.member.user && body.member.user.id))) ||
    (body.user && body.user.id);
  const user = (body.member && body.member.user) || body.user;
  const username = user && typeof user.username === "string" ? user.username : "";
  return { discordId: discordId || null, username };
}

// The one-time-login link: the code lives in a URL fragment (never a
// query string — a fragment is never sent to the server).
export function loginLinkUrl(siteUrl, code) {
  const base = siteUrl.endsWith("/") ? siteUrl : `${siteUrl}/`;
  return `${base}#login=${code}`;
}

// Runs background work after the response (ctx.waitUntil); without a ctx
// (unit tests) the work is awaited.
async function defer(ctx, promise) {
  if (ctx && ctx.waitUntil) ctx.waitUntil(promise.catch(() => {}));
  else await promise.catch(() => {});
}

// Looks the bearer token up in D1 (auth.js):
// { rec: { discordId, username, kind } } or { response }. The first
// successful use of a manual token deletes the /token reply that showed it.
async function authenticate(request, env, cors, ctx, fetchImpl) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return { response: json({ error: "missing bearer token" }, 401, cors) };
  const token = auth.slice("Bearer ".length);
  const rec = await authenticateToken(env.DB, token, new Date());
  if (!rec) return { response: json({ error: "unknown or revoked token" }, 401, cors) };
  if (rec.kind === "manual")
    await defer(ctx, sha256Hex(token).then(
      (hash) => deleteLinkedReplies(env.DB, fetchImpl, "token", hash)));
  return { rec };
}

// ----------------------------------------------------------------- handler

export default {
  // Wrangler entry point. `fetch` (the global) is passed through so the
  // same code path is unit-testable with an injected fetch.
  async fetch(request, env, ctx) {
    return handle(request, env, fetch, ctx);
  },
  // Cron trigger (every minute): deletes ephemeral replies that came due.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sweepDue(env.DB, fetch, new Date()));
  },
};

/**
 * Testable handler.
 * @param {Request} request
 * @param {object} env  { DB: D1, DISCORD_PUBLIC_KEY, GITHUB_TOKEN, GITHUB_OWNER,
 *                       GITHUB_REPO, ALLOWED_ORIGIN, SITE_URL,
 *                       UPLOAD_DAILY_BYTES?, UPLOAD_RESULTS_SECRET? }
 * @param {(url:string, init?:object)=>Promise<Response>} fetchImpl
 * @param {{waitUntil:(p:Promise)=>void}} [ctx]  background work after the response
 */
export async function handle(request, env, fetchImpl, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/discord") return handleDiscord(request, env, fetchImpl, ctx);
  if (url.pathname === "/upload") return handleUpload(request, env, fetchImpl, ctx);
  if (url.pathname === "/uploads/results") return handleUploadResults(request, env);
  if (url.pathname === "/whoami") return handleWhoami(request, env, fetchImpl, ctx);
  if (url.pathname === "/auth/redeem") return handleAuthRedeem(request, env, fetchImpl, ctx);
  if (url.pathname === "/auth/logout") return handleAuthLogout(request, env);
  return json({ error: "not found" }, 404);
}

// ------------------------------------------------------- POST /discord
// Interactions endpoint only (slash commands over HTTPS; no gateway).
// Discord requires the Ed25519 signature check and a reply within 3 s, so
// this handler makes NO GitHub calls. Every reply is the interaction
// response itself: 200 with a JSON body.

async function handleDiscord(request, env, fetchImpl, ctx) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const rawBody = await request.text();
  const ok = await verifyDiscordSignature(
    env.DISCORD_PUBLIC_KEY,
    request.headers.get("X-Signature-Timestamp"),
    rawBody,
    request.headers.get("X-Signature-Ed25519"));
  if (!ok) return json({ error: "bad signature" }, 401);

  let body;
  try { body = JSON.parse(rawBody); } catch { return json({ error: "bad json" }, 400); }

  if (body.type === 3) {
    const customId = body.data && body.data.custom_id;
    const reply = replier(body, env, ctx);
    if (customId === "mods_upload") return handleModsUpload(body, env, reply);
    if (customId === "mods_signout") return handleModsSignout(body, env, reply);
    if (customId === "mods_status") return handleModsStatus(body, env, reply);
    return json({ error: "unknown component" }, 400);
  }

  if (body.type !== 2) {
    if (body.type !== 1) return json({ error: "unexpected interaction type" }, 400);
    return json({ type: 1 }); // PONG
  }

  const { discordId, username } = interactionUser(body);
  if (!discordId) return json({ error: "missing user id" }, 400);
  if (!username) return json({ error: "missing username" }, 400);

  const command = (body.data && body.data.name) || "";
  const reply = replier(body, env, ctx);

  if (command === "token") {
    // One `manual` token per user: minting replaces the previous one
    // (re-minting is also the revoke path); web tokens are left alone.
    const token = await mintManualToken(env.DB, { discordId, username, now: new Date() });
    return reply(
      "## 🔑 Your upload token:\n" + "```\n" + token + "\n```\n" +
      "**This token is only shown once. Copy it before you dismiss this message.**\n" +
      "If you need a new token, or want to revoke your existing one, just regenerate a new one. The old one becomes invalid.",
      undefined, { tokenHash: await sha256Hex(token) });
  }

  return json({ error: `unknown command ${command}` }, 400);
}

// Builds the reply function for an interaction: an ephemeral reply (type 4
// + flags 64: only the invoking user sees it) that is recorded for deletion
// after 5 minutes (ephemeral.js). `link` ties it to the login code or manual
// token hash it carries, so using that secret deletes it early. Component
// replies are never type 7, which would edit the public #mods post in place.
function replier(body, env, ctx) {
  return async (content, components, link = {}) => {
    const data = { content, flags: 64, allowed_mentions: { parse: [] } };
    if (components) data.components = components;
    if (body.application_id && body.token) {
      await defer(ctx, scheduleDelete(env.DB, {
        applicationId: body.application_id, token: body.token, now: new Date(), ...link,
      }));
    }
    return json({ type: 4, data });
  };
}

// The #mods channel's "Upload or update a mod" button: mints a one-time
// login code and replies (ephemeral) with a link button to the site
// carrying it (URL fragment, never a query string). The code is never
// logged.
async function handleModsUpload(body, env, reply) {
  const { discordId, username } = interactionUser(body);
  if (!discordId) return json({ error: "missing user id" }, 400);
  if (!username) return reply("I couldn't find your Discord account name, so I can't sign you in.");
  const res = await mintLoginCode(env.DB, { discordId, username, now: new Date() });
  if (res.limited) return reply("You're clicking too fast, try again in a minute.");
  return reply(
    "This link signs you in to the catalog uploader. " +
    "It works once and expires in 5 minutes. Don't share it.",
    [{
      type: 1,
      components: [{
        type: 2, style: 5, label: "Open the uploader",
        url: loginLinkUrl(env.SITE_URL, res.code),
      }],
    }],
    { loginHash: await sha256Hex(res.code) });
}

// The #mods channel's "Sign out everywhere" button: deletes all the
// clicker's tokens (manual + web) and invalidates unused codes.
async function handleModsSignout(body, env, reply) {
  const { discordId } = interactionUser(body);
  if (!discordId) return json({ error: "missing user id" }, 400);
  await revokeAllTokens(env.DB, discordId);
  return reply("Signed out everywhere. Your /token token and all browser sessions are revoked.");
}

// The #mods channel's "Check upload status" button: the clicker's last 3
// uploads, newest first (the D1 `uploads` table; no GitHub call).
async function handleModsStatus(body, env, reply) {
  const { discordId } = interactionUser(body);
  if (!discordId) return json({ error: "missing user id" }, 400);
  return reply(statusMessage(await recentUploads(env.DB, discordId), env.SITE_URL));
}

// -------------------------------------------------------- POST /upload
// Authorization: Bearer <token>
// X-Filename: <name>.zip      (zip mode; set mode: see mod-contract/upload.md)
// body: the raw bytes, streamed straight through to GitHub (never buffered here).

async function handleUpload(request, env, fetchImpl, ctx) {
  const cors = { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Filename, X-Upload-Id, X-File-Idx, X-Part-Idx, X-Part-Count",
      },
    });
  }
  if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);

  // 1. token
  const auth = await authenticate(request, env, cors, ctx, fetchImpl);
  if (auth.response) return auth.response;
  const { discordId, username } = auth.rec;
  const stamp = uploaderStamp(discordId, username);

  // 2. size checks (before any GitHub call)
  const clHeader = request.headers.get("Content-Length");
  if (clHeader == null || !/^\d+$/.test(clHeader)) {
    return json({ error: "Content-Length header is required" }, 411, cors);
  }
  const contentLength = parseInt(clHeader, 10);
  if (contentLength > MAX_BODY_BYTES) {
    return json({ error: `upload is ${contentLength} bytes; the limit is 100 MB ` +
      "Split the package or contact the maintainer." }, 413, cors);
  }

  // 3. filename (zip packages vs raw file sets)
  const uploadId = (request.headers.get("X-Upload-Id") || "").trim();
  const raw = uploadId.length > 0;
  const filename = request.headers.get("X-Filename") || "";
  let assetName;
  // The upload's key in the status table: the set's upload id, or
  // `<ts>__<safe-name>.zip` for a zip package (the asset name without the
  // stamp; build.py's parse_inbox_name derives the same string).
  let uploadKey;
  // The workflow runs after a zip package or a set's manifest (the last
  // upload of a set); a set's parts only wait in the inbox.
  let completes = true;
  if (raw) {
    const fileIdx = request.headers.get("X-File-Idx");
    const partIdx = request.headers.get("X-Part-Idx");
    const partCount = request.headers.get("X-Part-Count");
    if (fileIdx == null || partIdx == null || partCount == null) {
      return json({ error: "raw uploads need X-File-Idx, X-Part-Idx, X-Part-Count" }, 400, cors);
    }
    const isManifest = fileIdx === MANIFEST_IDX;
    if (!isManifest && (!/^\d+$/.test(fileIdx) || !/^\d+$/.test(partIdx) || !/^\d+$/.test(partCount) || Number(partIdx) >= Number(partCount))) {
      return json({ error: "bad part headers" }, 400, cors);
    }
    if (isManifest) {
      if (filename !== "manifest.json" || partIdx !== "0" || partCount !== "1") {
        return json({ error: "bad manifest headers" }, 400, cors);
      }
      assetName = `${stamp}__${uploadId}__manifest.json`;
      uploadKey = uploadId;
    } else {
      const lower = filename.toLowerCase();
      if (!RAW_EXTENSIONS.some((e) => lower.endsWith(e))) {
        return json({ error: "set files must be .pak/.ucas/.utoc/.sig or one .zip " +
          "(plus the manifest.json upload)" }, 400, cors);
      }
      assetName = `${stamp}__${uploadId}__f${fileIdx}__p${partIdx}of${partCount}__${sanitizeFilename(filename)}`;
      completes = false;
    }
  } else {
    if (!filename.toLowerCase().endsWith(".zip")) {
      return json({ error: "X-Filename must end in .zip" }, 400, cors);
    }
    uploadKey = `${Math.floor(Date.now() / 1000)}__${sanitizeFilename(filename)}`;
    assetName = `${stamp}__${uploadKey}`;
  }

  // 4. daily quota, by BYTES (a set costs one charge per upload): charged
  // before streaming, refunded when the GitHub upload fails
  const limit = Number(env.UPLOAD_DAILY_BYTES) > 0 ? Number(env.UPLOAD_DAILY_BYTES) : DEFAULT_DAILY_BYTES;
  const charge = { discordId, day: new Date().toISOString().slice(0, 10), bytes: contentLength };
  if (!(await chargeQuota(env.DB, { ...charge, limit }))) {
    return json({ error: `daily upload limit reached (${Math.round(limit / 1073741824)} GiB/day UTC); try again tomorrow` }, 429, cors);
  }

  // 5. the fixed "inbox" release
  let inboxId;
  try {
    inboxId = await getInboxReleaseId(env, fetchImpl);
  } catch (ex) {
    await refundQuota(env.DB, charge);
    return json({ error: `github lookup failed: ${ex.message}` }, 502, cors);
  }
  if (inboxId == null) {
    await refundQuota(env.DB, charge);
    return json({ error: "uploads aren't set up yet; the catalog maintainer needs " +
      "to run the setup workflow once" }, 503, cors);
  }

  // 6. stream straight through (do NOT read the body into memory)
  let upload;
  try {
    upload = await fetchImpl(
      `https://uploads.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
      `/releases/${inboxId}/assets?name=${encodeURIComponent(assetName)}`,
      {
        method: "POST",
        body: request.body,
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "Content-Type": "application/zip",
          "Content-Length": String(contentLength),
          "User-Agent": GITHUB_UA,
        },
      });
  } catch (ex) {
    await refundQuota(env.DB, charge);
    return json({ error: `github upload failed: ${ex.message}` }, 502, cors);
  }
  if (!upload.ok) {
    if (upload.status === 404) inboxReleaseIds.delete(inboxKey(env));
    await refundQuota(env.DB, charge);
    return json({ error: `github upload failed: HTTP ${upload.status}` }, 502, cors);
  }
  if (!completes) return json({ status: "stored" }, 202, cors);

  // the upload now waits in the inbox; a D1 failure never fails the upload
  await recordWaiting(env.DB, {
    discordId, key: uploadKey, label: raw ? "mod upload" : filename, now: new Date(),
  }).catch(() => {});

  // 7. wake the workflow (wake-up only; it drains the inbox and skips
  // incomplete raw groups)
  let dispatch;
  try {
    dispatch = await fetchImpl(
      `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}` +
      `/actions/workflows/${INBOX_WAKE_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          "User-Agent": GITHUB_UA,
        },
        body: JSON.stringify({ ref: "main" }),
      });
  } catch (ex) {
    return json({ error: `github dispatch failed: ${ex.message}` }, 502, cors);
  }
  if (!dispatch.ok && dispatch.status !== 204) {
    return json({ error: `github dispatch failed: HTTP ${dispatch.status}` }, 502, cors);
  }
  return json({ status: "queued" }, 202, cors);
}

// ---------------------------------------------- POST /uploads/results
// The runner's outcome reports: a JSON list of { key, discord_id, status:
// "published"|"rejected", title?, version?, reason? }, authenticated with
// the UPLOAD_RESULTS_SECRET bearer secret (503 when unset). No CORS: only the
// workflow calls it.

async function constantTimeEqual(a, b) {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function handleUploadResults(request, env) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  if (!env.UPLOAD_RESULTS_SECRET) return json({ error: "upload results are not configured" }, 503);
  const auth = request.headers.get("Authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!(await constantTimeEqual(given, env.UPLOAD_RESULTS_SECRET)))
    return json({ error: "bad secret" }, 401);
  const declared = request.headers.get("Content-Length");
  if (declared != null && Number(declared) > MAX_RESULTS_BODY) return json({ error: "body too large" }, 413);
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > MAX_RESULTS_BODY) return json({ error: "body too large" }, 413);
  let list;
  try { list = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  if (!Array.isArray(list) || list.length > MAX_RESULTS)
    return json({ error: `expected a list of at most ${MAX_RESULTS} reports` }, 400);
  const valid = list.filter(validReport);
  const stored = await storeResults(env.DB, valid, new Date());
  return json({ stored, skipped: list.length - valid.length });
}

// -------------------------------------------------------- GET /whoami
// Bearer token -> the Discord account the catalog will publish uploads as.

async function handleWhoami(request, env, fetchImpl, ctx) {
  const cors = { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN };
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...cors,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization",
      },
    });
  }
  if (request.method !== "GET") return json({ error: "GET only" }, 405, cors);
  const auth = await authenticate(request, env, cors, ctx, fetchImpl);
  if (auth.response) return auth.response;
  return json({ discordId: auth.rec.discordId, username: auth.rec.username }, 200, cors);
}

// ------------------------------------------------------- POST /auth/*
// The one-time login-code flow (the site link `#login=<code>` redeems it
// for a long-lived web token): redeem = the atomic single-use burn (only
// the page's own script can call it; the code lives in the URL fragment),
// logout = delete the web token (a manual token is left alone). Same CORS
// pattern as /whoami. Codes and tokens are never logged.

const AUTH_MAX_BODY = 1024;

function authCors(env) {
  return { "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN };
}

function authPreflight(env) {
  return new Response(null, {
    status: 204,
    headers: {
      ...authCors(env),
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

// { code } or { response } (405/400). Rejects non-JSON and >1 KB bodies.
async function readCodeBody(request, env) {
  const cors = authCors(env);
  if (request.method === "OPTIONS") return { response: authPreflight(env) };
  if (request.method !== "POST") return { response: json({ error: "POST only" }, 405, cors) };
  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > AUTH_MAX_BODY) return { response: json({ error: "body too large" }, 400, cors) };
  let body;
  try { body = JSON.parse(raw); } catch { return { response: json({ error: "bad json" }, 400, cors) }; }
  const code = body && typeof body.code === "string" ? body.code : "";
  if (!code) return { response: json({ error: "missing code" }, 400, cors) };
  return { code };
}

function codeError(res, cors) {
  if (res.reason === "unknown")
    return json({ error: "unknown code", reason: "unknown" }, 404, cors);
  return json({ error: `code ${res.reason}`, reason: res.reason }, 410, cors);
}

async function handleAuthRedeem(request, env, fetchImpl, ctx) {
  const read = await readCodeBody(request, env);
  if (read.response) return read.response;
  const res = await redeemLoginCode(env.DB, read.code, new Date());
  if (res.ok) {
    // The login link has been opened: its Discord reply is spent.
    await defer(ctx, sha256Hex(read.code).then(
      (hash) => deleteLinkedReplies(env.DB, fetchImpl, "login", hash)));
    return json({ token: res.token, discordId: res.discordId, username: res.username, expiresAt: res.expiresAt }, 200, authCors(env));
  }
  return codeError(res, authCors(env));
}

async function handleAuthLogout(request, env) {
  const cors = authCors(env);
  if (request.method === "OPTIONS") return authPreflight(env);
  if (request.method !== "POST") return json({ error: "POST only" }, 405, cors);
  const auth = request.headers.get("Authorization") || "";
  if (auth.startsWith("Bearer ")) {
    // Only a `web` token is deleted; a `manual` one is left alone.
    await deleteWebToken(env.DB, auth.slice("Bearer ".length));
  }
  return new Response(null, { status: 204, headers: cors });
}

function inboxKey(env) {
  return `${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
}

// The inbox release id (null when the release does not exist yet).
async function getInboxReleaseId(env, fetchImpl) {
  const cached = inboxReleaseIds.get(inboxKey(env));
  if (cached != null) return cached;
  const res = await fetchImpl(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/${INBOX_TAG}`,
    { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": GITHUB_UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  inboxReleaseIds.set(inboxKey(env), data.id);
  return data.id;
}
