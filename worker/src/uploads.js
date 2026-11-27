// Per-user upload status (D1 table `uploads`): what the #mods "Check upload
// status" button shows. The Worker records an upload as 'waiting' when it
// queues it; the runner reports the outcome to POST /uploads/results.

const KEEP_PER_USER = 20;
const RECENT = 3;
export const MAX_RESULTS = 20;       // reports per request
export const MAX_RESULTS_BODY = 65536;

export const USQL = {
  insertWaiting: "INSERT OR IGNORE INTO uploads (discord_id, upload_key, uploaded_at, label, status, updated_at) VALUES (?1, ?2, ?3, ?4, 'waiting', ?3)",
  upsertResult: "INSERT INTO uploads (discord_id, upload_key, uploaded_at, label, status, title, version, reason, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?3) ON CONFLICT (discord_id, upload_key) DO UPDATE SET status = excluded.status, title = excluded.title, version = excluded.version, reason = excluded.reason, updated_at = excluded.updated_at",
  prune: `DELETE FROM uploads WHERE discord_id = ?1 AND upload_key NOT IN (SELECT upload_key FROM uploads WHERE discord_id = ?1 ORDER BY uploaded_at DESC LIMIT ${KEEP_PER_USER})`,
  recent: `SELECT * FROM uploads WHERE discord_id = ?1 ORDER BY uploaded_at DESC LIMIT ${RECENT}`,
};

const clip = (v, n) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null);

// Records a queued upload (zip package or a set's manifest) as 'waiting'.
export async function recordWaiting(db, { discordId, key, label, now }) {
  await db.prepare(USQL.insertWaiting).bind(
    discordId, key, now.toISOString(), clip(label, 100) || "upload").run();
  await db.prepare(USQL.prune).bind(discordId).run();
}

// A report is valid when it names a key and a Discord id and a final status.
export function validReport(r) {
  return !!r && typeof r === "object" &&
    typeof r.key === "string" && r.key.length > 0 && r.key.length <= 300 &&
    typeof r.discord_id === "string" && /^\d{1,32}$/.test(r.discord_id) &&
    (r.status === "published" || r.status === "rejected");
}

// Upserts the runner's reports (an unknown key inserts a row with the
// current time). Returns the number stored.
export async function storeResults(db, reports, now) {
  const stmts = reports.map((r) => db.prepare(USQL.upsertResult).bind(
    r.discord_id, r.key, now.toISOString(), clip(r.title, 100) || "upload", r.status,
    clip(r.title, 200), clip(r.version, 50), clip(r.reason, 300)));
  if (stmts.length) await db.batch(stmts);
  for (const id of new Set(reports.map((r) => r.discord_id)))
    await db.prepare(USQL.prune).bind(id).run();
  return reports.length;
}

export async function recentUploads(db, discordId) {
  const { results } = await db.prepare(USQL.recent).bind(discordId).all();
  return results;
}

// User-controlled text in a Discord message: no mentions or autolink
// brackets, markdown characters escaped.
export function cleanText(text, limit) {
  return String(text ?? "").replace(/[@<>`]/g, "").slice(0, limit)
    .replace(/[\\*_~|[\]()]/g, (c) => `\\${c}`);
}

function describe(row) {
  const name = row.title
    ? `**${cleanText(row.title, 60)}**${row.version ? ` v${cleanText(row.version, 20)}` : ""}`
    : `**${cleanText(row.label, 60)}**`;
  return name;
}

function statusText(row, siteUrl) {
  if (row.status === "published")
    return `✅ Published${siteUrl ? ` (<${siteUrl}>)` : ""}`;
  if (row.status === "rejected")
    return `❌ Rejected: ${cleanText(row.reason || "no reason given", 200)}`;
  return "⏳ Waiting to be processed";
}

// The ephemeral reply of the status button (newest first).
export function statusMessage(rows, siteUrl) {
  if (!rows.length)
    return "You haven't uploaded anything yet. Use **Upload or update a mod** to share one.";
  const lines = rows.map((row, i) => {
    const ts = Math.floor(Date.parse(row.uploaded_at) / 1000);
    return `${i + 1}. <t:${ts}:f> (<t:${ts}:R>)\n${describe(row)}: ${statusText(row, siteUrl)}`;
  });
  return `**Your last ${rows.length === 1 ? "upload" : `${rows.length} uploads`}**\n${lines.join("\n")}`.slice(0, 2000);
}
