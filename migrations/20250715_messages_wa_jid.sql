-- Add wa_jid to messages (stores the real WhatsApp JID, may be @lid for privacy accounts)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS wa_jid TEXT;
