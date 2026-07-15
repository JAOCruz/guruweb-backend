-- Persist pending WhatsApp QR codes so any Railway instance can serve them.
ALTER TABLE wa_credentials
  ADD COLUMN IF NOT EXISTS pending_qr TEXT,
  ADD COLUMN IF NOT EXISTS pending_qr_at TIMESTAMP WITH TIME ZONE;

-- Helper: ensure a row exists for the session so we can store the QR before auth completes.
INSERT INTO wa_credentials (session_id, creds, keys, pending_qr, pending_qr_at)
VALUES ('placeholder', '{}', '{}', NULL, NULL)
ON CONFLICT (session_id) DO NOTHING;

DELETE FROM wa_credentials WHERE session_id = 'placeholder';
