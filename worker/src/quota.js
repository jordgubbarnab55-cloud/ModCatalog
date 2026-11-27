// Daily upload quota (D1 table `upload_quota`, one row per Discord user:
// the UTC day it counts and the bytes charged that day).
//
// Charging is one statement: the upsert only takes effect when the day's
// total including this charge stays within the limit, and `meta.changes`
// tells whether it did. A row from an earlier day restarts at zero.

// One statement per transition; FakeD1 in the tests matches these.
export const QSQL = {
  charge:
    "INSERT INTO upload_quota (discord_id, day, bytes) SELECT ?1, ?2, ?3 WHERE ?3 <= ?4 " +
    "ON CONFLICT(discord_id) DO UPDATE SET " +
    "bytes = CASE WHEN upload_quota.day = excluded.day THEN upload_quota.bytes + excluded.bytes ELSE excluded.bytes END, " +
    "day = excluded.day " +
    "WHERE (CASE WHEN upload_quota.day = excluded.day THEN upload_quota.bytes ELSE 0 END) + excluded.bytes <= ?4",
  refund:
    "UPDATE upload_quota SET bytes = MAX(bytes - ?3, 0) WHERE discord_id = ?1 AND day = ?2",
};

// True when `bytes` fit in today's allowance and were charged.
export async function chargeQuota(db, { discordId, day, bytes, limit }) {
  const r = await db.prepare(QSQL.charge).bind(discordId, day, bytes, limit).run();
  return ((r.meta && r.meta.changes) || 0) === 1;
}

// Gives back a charge whose upload did not reach GitHub.
export async function refundQuota(db, { discordId, day, bytes }) {
  await db.prepare(QSQL.refund).bind(discordId, day, bytes).run();
}
