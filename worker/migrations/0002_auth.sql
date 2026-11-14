-- Auth (D1): tokens and one-time login codes.
--
-- tokens: kind 'manual' = minted by the Discord /token command (one per
-- user; a re-mint replaces it; never expires); kind 'web' = minted by
-- redeeming a login code (many per user; 90-day expiry). Only sha256
-- hashes of the secret strings are stored (manual `mm_…`, web `ms_…`).
--
-- login_codes: one-time site-login codes (`lc_…`), 5-minute TTL, burned
-- atomically (used_at set only when the row was still unused and unexpired);
-- a newer code invalidates the user's older unused codes.
CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT PRIMARY KEY,           -- sha256 hex of the token string
  discord_id TEXT NOT NULL,
  username   TEXT NOT NULL,
  kind       TEXT NOT NULL,              -- 'manual' | 'web'
  created_at TEXT NOT NULL,
  expires_at TEXT                        -- NULL = never
);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(discord_id, kind);
CREATE TABLE IF NOT EXISTS login_codes (
  hash       TEXT PRIMARY KEY,
  discord_id TEXT NOT NULL,
  username   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT                         -- set when burned OR invalidated by a newer code
);
CREATE INDEX IF NOT EXISTS idx_codes_user ON login_codes(discord_id, created_at);
