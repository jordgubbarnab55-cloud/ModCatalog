-- 0006: ephemeral Discord replies scheduled for deletion.
-- One row per reply the Worker sent: the interaction token authorizes
-- deleting the reply for 15 minutes. delete_at is when the cron sweep
-- removes it; login_hash / token_hash link the reply to the login code or
-- manual token it carries, so using that secret deletes the reply early.
CREATE TABLE ephemeral_deletes (
  interaction_token TEXT PRIMARY KEY,
  application_id    TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  delete_at         TEXT NOT NULL,
  login_hash        TEXT,
  token_hash        TEXT
);
CREATE INDEX idx_ephemeral_delete_at ON ephemeral_deletes(delete_at);
CREATE INDEX idx_ephemeral_login ON ephemeral_deletes(login_hash);
CREATE INDEX idx_ephemeral_token ON ephemeral_deletes(token_hash);
