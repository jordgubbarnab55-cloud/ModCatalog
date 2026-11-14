// Token and login-code store (D1, binding `DB`).
//
// Tokens (table `tokens`): kind `manual` = minted by the Discord /token
// command (one per user; a re-mint replaces it; never expires); kind
// `web` = minted by redeeming a one-time login code (many per user;
// 90-day expiry). Only sha256 hashes are stored, never plaintext.
//
// Login codes (table `login_codes`): 5-minute TTL, single-use; redeemed
// atomically (the burn UPDATE must change exactly one row) for a web
// token. Minting a code invalidates that user's older unused codes.
//
// Every function takes `db` (env.DB) and an explicit `now` Date, so the
// whole thing is testable. Codes and tokens are never logged.

// One statement per transition; FakeD1 in the tests matches these.
export const ASQL = {
  deleteManual: "DELETE FROM tokens WHERE discord_id = ?1 AND kind = 'manual'",
  insertToken: "INSERT INTO tokens (hash, discord_id, username, kind, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  getToken: "SELECT * FROM tokens WHERE hash = ?1",
  deleteWeb: "DELETE FROM tokens WHERE hash = ?1 AND kind = 'web'",
  deleteAllTokens: "DELETE FROM tokens WHERE discord_id = ?1",
  codeCount60s: "SELECT COUNT(*) AS n FROM login_codes WHERE discord_id = ?1 AND created_at > ?2",
  invalidateCodes: "UPDATE login_codes SET used_at = ?2 WHERE discord_id = ?1 AND used_at IS NULL",
  insertCode: "INSERT INTO login_codes (hash, discord_id, username, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)",
  deleteOldCodes: "DELETE FROM login_codes WHERE created_at < ?1",
  getCode: "SELECT * FROM login_codes WHERE hash = ?1",
  burnCode: "UPDATE login_codes SET used_at = ?1 WHERE hash = ?2 AND used_at IS NULL AND expires_at > ?1",
};

const CODE_TTL_MS = 300 * 1000;             // 5 minutes
const CODE_RATE_LIMIT = 5;                 // max codes per user per 60 s
const CODE_RATE_WINDOW_MS = 60 * 1000;
const CODE_SWEEP_MS = 24 * 3600 * 1000;    // rows older than this are swept
const WEB_TOKEN_TTL_MS = 90 * 24 * 3600 * 1000; // 90 days

export function base64url(bytes) {
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A fresh secret: prefix + base64url(32 random bytes).
export function newSecret(prefix) {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return prefix + base64url(bytes);
}

export async function sha256Hex(input) {
  const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Small D1 wrapper: `q(db, name, ...args)` -> { row } or { changes }.
async function q(db, name, ...args) {
  const stmt = db.prepare(ASQL[name]).bind(...args);
  if (name === "getToken" || name === "getCode" || name === "codeCount60s") {
    const r = await stmt.first();
    return { row: r || null };
  }
  const r = await stmt.run();
  return { changes: (r.meta && r.meta.changes) || 0 };
}

// Mints the user's `manual` token (replacing any previous one; web
// tokens are left alone). Returns the plaintext once.
export async function mintManualToken(db, { discordId, username, now }) {
  await q(db, "deleteManual", discordId);
  const token = newSecret("mm_");
  await q(db, "insertToken", await sha256Hex(token), discordId, username,
    "manual", now.toISOString(), null);
  return token;
}

// Mints a one-time login code. Invalidates the user's older unused
// codes, refuses (limited) when 5+ codes were created in the last
// 60 s, and opportunistically sweeps rows older than 24 h.
export async function mintLoginCode(db, { discordId, username, now }) {
  const since = new Date(now.getTime() - CODE_RATE_WINDOW_MS).toISOString();
  const { row } = await q(db, "codeCount60s", discordId, since);
  if (row && Number(row.n) >= CODE_RATE_LIMIT) return { limited: true };
  await q(db, "invalidateCodes", discordId, now.toISOString());
  const code = newSecret("lc_");
  await q(db, "insertCode", await sha256Hex(code), discordId, username,
    now.toISOString(), new Date(now.getTime() + CODE_TTL_MS).toISOString());
  await q(db, "deleteOldCodes", new Date(now.getTime() - CODE_SWEEP_MS).toISOString());
  return { code };
}

// Read-only check (page load / link prefetch must never burn the code).
export async function peekLoginCode(db, code, now) {
  const row = (await q(db, "getCode", await sha256Hex(code))).row;
  if (!row) return { ok: false, reason: "unknown" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: "expired" };
  return { ok: true, discordId: row.discord_id, username: row.username, expiresAt: row.expires_at };
}

// The atomic single-use burn: the UPDATE succeeds only when exactly one
// row changed (a concurrent redeem, or a mint that invalidated the code,
// won the race). Then mints the 90-day `web` token.
export async function redeemLoginCode(db, code, now) {
  const hash = await sha256Hex(code);
  const row = (await q(db, "getCode", hash)).row;
  if (!row) return { ok: false, reason: "unknown" };
  if (row.used_at) return { ok: false, reason: "used" };
  if (Date.parse(row.expires_at) <= now.getTime()) return { ok: false, reason: "expired" };
  if ((await q(db, "burnCode", now.toISOString(), hash)).changes !== 1)
    return { ok: false, reason: "used" };
  const token = newSecret("ms_");
  await q(db, "insertToken", await sha256Hex(token), row.discord_id, row.username,
    "web", now.toISOString(), new Date(now.getTime() + WEB_TOKEN_TTL_MS).toISOString());
  return { ok: true, token, discordId: row.discord_id, username: row.username, expiresAt: row.expires_at };
}

// Bearer-token lookup: unknown or expired -> null.
export async function authenticateToken(db, token, now) {
  const row = (await q(db, "getToken", await sha256Hex(token))).row;
  if (!row) return null;
  if (row.expires_at != null && Date.parse(row.expires_at) <= now.getTime()) return null;
  return { discordId: row.discord_id, username: row.username, kind: row.kind };
}

// Deletes the token only when it is a `web` one (manual is left alone).
export async function deleteWebToken(db, token) {
  await q(db, "deleteWeb", await sha256Hex(token));
}

// Removes every token of the user and invalidates their unused codes.
export async function revokeAllTokens(db, discordId, now = new Date()) {
  await q(db, "deleteAllTokens", discordId);
  await q(db, "invalidateCodes", discordId, now.toISOString());
}
