-- Forum ingestion state: one row per candidate thread in the configured
-- forum channel. Statuses:
--   prompting        row inserted, the prompt message is not (yet) posted;
--                   a row stuck here >10 min without prompt_msg is retried
--   awaiting         prompt posted; waiting for the owner's click or the
--                   36 h auto-publish (auto_due = prompt_sent_at + 36 h)
--   awaiting_package no owner zip at first sight; re-checked on new messages,
--                   cleaned up 36 h after creation if none ever appears
--   processing       dispatching/dispatched (a click or the auto path won
--                   the awaiting->processing race); reconciled against the
--                   catalog, watchdog after ~30 min
--   unconfirmed      processing with no catalog confirmation after the
--                   watchdog; reconciled until 48 h, then deleted
--   published        the mod (ident_key, updated >= dispatched_at) is in the
--                   catalog; deleted after 48 h
--   declined         the owner clicked "No thanks"; terminal, deleted 48 h
--   failed           a known failure (quota, dispatch attempts exhausted,
--                   zip gone, ingest-stage failure); terminal, deleted 48 h
CREATE TABLE IF NOT EXISTS forum_posts (
  thread_id      TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  owner_name     TEXT NOT NULL,
  status         TEXT NOT NULL,
  prompt_msg     TEXT,           -- the bot prompt message id
  last_msg_id    TEXT,           -- last thread message id already inspected
  created_at     TEXT NOT NULL,
  prompt_sent_at TEXT,
  auto_due       TEXT,
  dispatched_at  TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  detail         TEXT,           -- failure reason / result note, bounded
  ident_key      TEXT,           -- lowercase identifier computed AT DISPATCH
  pkg_sha256     TEXT,           -- sha256 of the package file (status callback)
  pkg_size       INTEGER         -- bytes charged to the owner's quota
);
CREATE INDEX IF NOT EXISTS idx_forum_status ON forum_posts(status);
