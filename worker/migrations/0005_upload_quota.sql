-- 0005: upload quotas live in D1; the mirror state tables are dropped.
CREATE TABLE upload_quota (
  discord_id TEXT PRIMARY KEY,
  day        TEXT NOT NULL,
  bytes      INTEGER NOT NULL
);
DROP TABLE IF EXISTS mod_threads;
DROP TABLE IF EXISTS seen_events;
