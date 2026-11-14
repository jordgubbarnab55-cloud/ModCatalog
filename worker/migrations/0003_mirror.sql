-- Catalog outcome-event mirroring (POST /catalog/events).
--
-- mod_threads: one row per mirrored mod. mod_key = the trailer
-- identifier lowercased (the catalog id's ident_key); thread_id = the
-- Discord forum thread the mod lives in. A thread deleted on Discord
-- is replaced: the row is re-written with the new thread.
--
-- seen_events: the eventIds already mirrored, so a redelivered event
-- (the runner retries on network errors and 5xx) is a no-op. Rows are
-- swept 30 days after creation.
CREATE TABLE IF NOT EXISTS mod_threads (
  mod_key    TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_events (
  event_id   TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
