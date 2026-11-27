// Self-deleting ephemeral Discord replies (D1 table `ephemeral_deletes`).
//
// Every inline reply is recorded with its interaction token, which
// authorizes `DELETE /webhooks/{application_id}/{token}/messages/@original`
// without a bot token for 15 minutes. A cron sweep deletes replies when
// they come due (5 minutes); a reply carrying a login code or manual token
// is deleted as soon as that secret is used.

const DISCORD_API = "https://discord.com/api/v10";
const DISCORD_UA = "ModCatalog-Worker";
export const REPLY_TTL_MS = 5 * 60 * 1000;
// Interaction tokens die after 15 minutes; rows older than this are dropped
// whether or not the delete succeeded.
const TOKEN_LIFETIME_MS = 14 * 60 * 1000;

export const ESQL = {
  insert: "INSERT OR REPLACE INTO ephemeral_deletes (interaction_token, application_id, created_at, delete_at, login_hash, token_hash) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  byLogin: "SELECT * FROM ephemeral_deletes WHERE login_hash = ?1",
  byToken: "SELECT * FROM ephemeral_deletes WHERE token_hash = ?1",
  due: "SELECT * FROM ephemeral_deletes WHERE delete_at <= ?1",
  remove: "DELETE FROM ephemeral_deletes WHERE interaction_token = ?1",
  removeStale: "DELETE FROM ephemeral_deletes WHERE created_at < ?1",
};

// Records a reply for deletion `REPLY_TTL_MS` after `now`.
export async function scheduleDelete(db, { applicationId, token, now, loginHash = null, tokenHash = null }) {
  await db.prepare(ESQL.insert).bind(
    token, applicationId, now.toISOString(),
    new Date(now.getTime() + REPLY_TTL_MS).toISOString(), loginHash, tokenHash).run();
}

// True when the message is gone (deleted now, or already deleted: 404).
export async function deleteReply(fetchImpl, applicationId, token) {
  try {
    const res = await fetchImpl(
      `${DISCORD_API}/webhooks/${applicationId}/${token}/messages/@original`,
      { method: "DELETE", headers: { "User-Agent": DISCORD_UA } });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

async function deleteRows(db, fetchImpl, rows) {
  for (const row of rows) {
    if (await deleteReply(fetchImpl, row.application_id, row.interaction_token))
      await db.prepare(ESQL.remove).bind(row.interaction_token).run();
  }
}

// Deletes the replies linked to a login code hash (`kind` "login") or a
// manual token hash ("token"), the moment that secret is used.
export async function deleteLinkedReplies(db, fetchImpl, kind, hash) {
  const { results } = await db.prepare(kind === "login" ? ESQL.byLogin : ESQL.byToken).bind(hash).all();
  await deleteRows(db, fetchImpl, results);
}

// The cron sweep: deletes due replies (a failed delete is retried on the
// next run) and drops rows whose interaction token has expired.
export async function sweepDue(db, fetchImpl, now) {
  const { results } = await db.prepare(ESQL.due).bind(now.toISOString()).all();
  await deleteRows(db, fetchImpl, results);
  await db.prepare(ESQL.removeStale).bind(
    new Date(now.getTime() - TOKEN_LIFETIME_MS).toISOString()).run();
}
