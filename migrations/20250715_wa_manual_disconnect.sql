-- Track manual disconnects so auto-reconnect (startup) skips sessions the
-- admin deliberately turned off. Cleared when a fresh /connect deletes the row.
ALTER TABLE wa_credentials ADD COLUMN IF NOT EXISTS manual_disconnect BOOLEAN NOT NULL DEFAULT FALSE;
