-- Backup column for WhatsApp credentials so we can recover from partial/corrupt updates
ALTER TABLE wa_credentials ADD COLUMN IF NOT EXISTS creds_backup JSONB;
