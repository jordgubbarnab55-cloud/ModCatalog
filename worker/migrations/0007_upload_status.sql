-- 0007: per-user upload status behind the #mods "Check upload status" button.
-- One row per upload: the Worker inserts it as 'waiting' when it queues the
-- upload, the runner's report (POST /uploads/results) turns it into
-- 'published' or 'rejected'. upload_key is the upload id of a set, or
-- `<ts>__<safe-name>.zip` of a zip package (the inbox asset name without the
-- uploader stamp). Only the newest rows of each user are kept.
CREATE TABLE uploads (
  discord_id  TEXT NOT NULL,
  upload_key  TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  label       TEXT NOT NULL,
  status      TEXT NOT NULL,
  title       TEXT,
  version     TEXT,
  reason      TEXT,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (discord_id, upload_key)
);
CREATE INDEX idx_uploads_user_time ON uploads(discord_id, uploaded_at);
