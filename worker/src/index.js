// ModCatalog Worker: Discord interactions (token minting) + streaming upload
// API. Plain JS ES module, zero dependencies.
//
// Everything that talks to a service is injectable: the handler takes `env`
// (KV binding + secrets + vars) and a `fetch` function, so tests can supply
// fakes. The Worker never stores file bytes: the upload body is streamed
// straight through to GitHub releases (no buffering, no cold storage).
//
// Two upload shapes:
//   * zip packages: X-Filename <name>.zip, one upload per package, no upload id
//
// Every inbox asset name starts with the uploader stamp (uploaderStamp).
//   * upload sets: either the loose .utoc/.ucas/.pak(/.sig) files or exactly
//     one .zip (part-split when over 100 MB), plus a manifest.json upload and
//     an optional metadata.json upload, all tagged with the same X-Upload-Id;
//     the workflow reassembles, applies the metadata and zips on the runner
//     (this Worker cannot — 10 ms CPU, stateless).

const MAX_BODY_BYTES = 100 * 1024 * 1024; // Cloudflare free-plan request-body limit
const DEFAULT_DAILY_BYTES = 2147483648; // 2 GiB of uploads per user per UTC day
const RAW_EXTENSIONS = [".pak", ".ucas", ".utoc", ".sig", ".zip"];
// Fixed X-File-Idx values of the two non-file parts of an upload set.
const MANIFEST_IDX = "-1";
const METADATA_IDX = "-2";
const INBOX_CACHE_KEY = "cache:inbox_release_id";
const INBOX_CACHE_MS = 3600 * 1000;
const INBOX_TAG = "inbox";
const INBOX_WAKE_WORKFLOW = "process-inbox.yml";
// GitHub's API rejects requests without a User-Agent (403 "administrative
// rules"); the Worker's fetch sends none by default.
const GITHUB_UA = "ModCatalog-Worker";

// ---------------------------------------------------------------- helpers

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });
}

async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes) {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function newToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "mm_" + base64url(bytes);
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
function uploaderStamp(discordId, username) {
  const hex = [...new TextEncoder().encode(username)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${discordId}-${hex}`;
}

const STALE_TOKEN_MESSAGE =
  "this token is outdated; mint a new one with /token in Discord";

// Looks the bearer token up: { rec: { discordId, username } } or { response }.
async function authenticate(request, env, cors) {
  const auth = request.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return { response: json({ error: "missing bearer token" }, 401, cors) };
  const tokenHash = await sha256Hex(auth.slice("Bearer ".length));
  const raw = await env.TOKENS.get(`tok:${tokenHash}`);
  if (!raw) return { response: json({ error: "unknown or revoked token" }, 401, cors) };
  const rec = JSON.parse(raw);
  if (!rec.username) return { response: json({ error: STALE_TOKEN_MESSAGE }, 401, cors) };
  return { rec };
}

// ----------------------------------------------------------------- handler

export default {
  // Wrangler entry point. `fetch` (the global) is passed through so the
  // same code path is unit-testable with an injected fetch.
  async fetch(request, env) {
    return handle(request, env, fetch);
  },
};

/**
 * Testable handler.
 * @param {Request} request
 * @param {object} env  { TOKENS: kv-like, DISCORD_PUBLIC_KEY, GITHUB_TOKEN,
 *                       GITHUB_OWNER, GITHUB_REPO, ALLOWED_ORIGIN,
 *                       UPLOAD_DAILY_LIMIT? }
 * @param {(url:string, init?:object)=>Promise<Response>} fetchImpl
 */
export async function handle(request, env, fetchImpl) {
  const url = new URL(request.url);
  if (url.pathname === "/discord") return handleDiscord(request, env, fetchImpl);
  if (url.pathname === "/upload") return handleUpload(request, env, fetchImpl);
  if (url.pathname === "/whoami") return handleWhoami(request, env);
  return json({ error: "not found" }, 404);
}

// ------------------------------------------------------- POST /discord
// Interactions endpoint only (slash commands over HTTPS; no gateway).
// Discord requires the Ed25519 signature check and a reply within 3 s, so
// this handler makes NO GitHub calls.

async function handleDiscord(request, env, fetchImpl) {
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

  if (body.type !== 2) {
    // PING is ACKed through the callback endpoint too (type 1 = PONG).
    if (body.type !== 1) return json({ error: "unexpected interaction type" }, 400);
    const pong = await sendCallback(body, { type: 1 }, fetchImpl);
    if (!pong) return json({ error: "discord callback failed" }, 502);
    return new Response(null, { status: 202 }); // ACK: no body
  }

  // Identity: the current Discord interaction member object has NO top-level
  // id — the user id is nested at member.user.id (keep member.id and the
  // DM user.id as fallbacks for other payload variants).
  const discordId =
    (body.member && (body.member.id || (body.member.user && body.member.user.id))) ||
    (body.user && body.user.id);
  if (!discordId) return json({ error: "missing user id" }, 400);

  // The Discord account name (`username`): not the display name, not the
  // server nickname. It is what the catalog publishes as the mods' author.
  const user = (body.member && body.member.user) || body.user;
  const username = user && typeof user.username === "string" ? user.username : "";

  const sub = (body.data && body.data.options || [])
    .find((o) => o.type === 2); // Subcommand
  const command = (body.data && body.data.name) || "";

  if (command === "token" && sub && sub.name === "revoke") {
    const hash = await env.TOKENS.get(`user:${discordId}`);
    if (hash) {
      await env.TOKENS.delete(`tok:${hash}`);
      await env.TOKENS.delete(`user:${discordId}`);
    }
    const ack = await sendCallback(body, { type: 4, data: { content: "Your upload token has been revoked.", flags: 64 } }, fetchImpl);
    if (!ack) return json({ error: "discord callback failed" }, 502);
    return new Response(null, { status: 202 }); // ACK: no body
  }

  if (command === "token") {
    if (!username) return json({ error: "missing username" }, 400);
    // One active token per user: invalidate the previous one.
    const oldHash = await env.TOKENS.get(`user:${discordId}`);
    if (oldHash) await env.TOKENS.delete(`tok:${oldHash}`);

    const token = newToken();
    const hash = await sha256Hex(token); // only the hash is stored, ever
    await env.TOKENS.put(`tok:${hash}`,
      JSON.stringify({ discordId, username, createdAt: new Date().toISOString() }));
    await env.TOKENS.put(`user:${discordId}`, hash);
    const ack = await sendCallback(body, {
      type: 4,
      data: {
        content:
          `## 🔑 Your upload token:\n` + `\`\`\`\n${token}\n\`\`\`\n` +
          `**This token is only shown once. Copy it before you dismiss this message.**\n` + 
          `If you need a new token, or want to revoke your existing one, just regenerate a new one. The old one becomes invalid.`,
        flags: 64, // ephemeral: only this user sees it
      },
    }, fetchImpl);
    if (!ack) return json({ error: "discord callback failed" }, 502);
    return new Response(null, { status: 202 }); // ACK: no body
  }

  return json({ error: `unknown command ${command}` }, 400);
}

// The canonical response flow: ACK the original request with a 202 (no
// body), then POST the actual response to the interaction callback
// endpoint (valid for 15 minutes; the 3 s budget covers the ACK only).
// Returns true when Discord accepted the callback.
async function sendCallback(body, responseObj, fetchImpl) {
  const res = await fetchImpl(
    `https://discord.com/api/v10/interactions/${body.id}/${body.token}/callback`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(responseObj) });
  if (res.ok || res.status === 204) return true;
  console.error(`discord callback failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  return false;
}

// -------------------------------------------------------- POST /upload
// Authorization: Bearer <token>
// X-Filename: <name>.zip      (zip mode; set mode: see mod-contract/upload.md)
// body: the raw bytes, streamed straight through to GitHub (never buffered here).

async function handleUpload(request, env, fetchImpl) {
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
  const auth = await authenticate(request, env, cors);
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
  if (raw) {
    // raw file sets: the set's files plus a small manifest, all tagged with
    // X-Upload-Id. The workflow reassembles parts and zips on the runner.
    const fileIdx = request.headers.get("X-File-Idx");
    const partIdx = request.headers.get("X-Part-Idx");
    const partCount = request.headers.get("X-Part-Count");
    if (fileIdx == null || partIdx == null || partCount == null) {
      return json({ error: "raw uploads need X-File-Idx, X-Part-Idx, X-Part-Count" }, 400, cors);
    }
    const isManifest = fileIdx === MANIFEST_IDX;
    const isMetadata = fileIdx === METADATA_IDX;
    if (!isManifest && !isMetadata && (!/^\d+$/.test(fileIdx) || !/^\d+$/.test(partIdx) || !/^\d+$/.test(partCount) || Number(partIdx) >= Number(partCount))) {
      return json({ error: "bad part headers" }, 400, cors);
    }
    if (isManifest) {
      if (filename !== "manifest.json" || partIdx !== "0" || partCount !== "1") {
        return json({ error: "bad manifest headers" }, 400, cors);
      }
      assetName = `${stamp}__${uploadId}__manifest.json`;
    } else if (isMetadata) {
      if (filename !== "metadata.json" || partIdx !== "0" || partCount !== "1") {
        return json({ error: "bad metadata headers" }, 400, cors);
      }
      assetName = `${stamp}__${uploadId}__metadata.json`;
    } else {
      const lower = filename.toLowerCase();
      if (!RAW_EXTENSIONS.some((e) => lower.endsWith(e))) {
        return json({ error: "set files must be .pak/.ucas/.utoc/.sig or one .zip " +
          "(plus the manifest.json and metadata.json uploads)" }, 400, cors);
      }
      assetName = `${stamp}__${uploadId}__f${fileIdx}__p${partIdx}of${partCount}__${sanitizeFilename(filename)}`;
    }
  } else {
    if (!filename.toLowerCase().endsWith(".zip")) {
      return json({ error: "X-Filename must end in .zip" }, 400, cors);
    }
    assetName = `${stamp}__${Math.floor(Date.now() / 1000)}__${sanitizeFilename(filename)}`;
  }

  // 4. daily quota, by BYTES (a raw set costs N part uploads; KV is
  // eventually consistent, a slightly late count is fine)
  const limit = Number(env.UPLOAD_DAILY_BYTES) > 0 ? Number(env.UPLOAD_DAILY_BYTES) : DEFAULT_DAILY_BYTES;
  const today = new Date().toISOString().slice(0, 10);
  const qKey = `quota:${discordId}`;
  let used = 0;
  const qRaw = await env.TOKENS.get(qKey);
  if (qRaw) {
    const q = JSON.parse(qRaw);
    if (q.date === today) used = q.bytes || 0;
  }
  if (used + contentLength > limit) {
    return json({ error: `daily upload limit reached (${Math.round(limit / 1073741824)} GiB/day UTC); try again tomorrow` }, 429, cors);
  }

  // 5. the fixed "inbox" release (id cached in KV)
  const inboxId = await getInboxReleaseId(env, fetchImpl);
  if (inboxId == null) {
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
    return json({ error: `github upload failed: ${ex.message}` }, 502, cors);
  }
  if (!upload.ok) {
    return json({ error: `github upload failed: HTTP ${upload.status}` }, 502, cors);
  }

  // 7. charge the bytes, then wake the workflow (wake-up only; it drains
  // the inbox and skips incomplete raw groups)
  await env.TOKENS.put(qKey, JSON.stringify({ date: today, bytes: used + contentLength }));
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

// -------------------------------------------------------- GET /whoami
// Bearer token -> the Discord account the catalog will publish uploads as.

async function handleWhoami(request, env) {
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
  const auth = await authenticate(request, env, cors);
  if (auth.response) return auth.response;
  return json({ discordId: auth.rec.discordId, username: auth.rec.username }, 200, cors);
}

async function getInboxReleaseId(env, fetchImpl) {
  const cached = await env.TOKENS.get(INBOX_CACHE_KEY);
  if (cached) {
    const c = JSON.parse(cached);
    if (Date.now() - c.at < INBOX_CACHE_MS) return c.id;
  }
  const res = await fetchImpl(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/releases/tags/${INBOX_TAG}`,
    { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, "User-Agent": GITHUB_UA } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`github release lookup failed: HTTP ${res.status}`);
  const data = await res.json();
  await env.TOKENS.put(INBOX_CACHE_KEY, JSON.stringify({ id: data.id, at: Date.now() }));
  return data.id;
}
