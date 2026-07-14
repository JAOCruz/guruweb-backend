-- Add source column to distinguish simulator-generated records from real WhatsApp ones
ALTER TABLE clients ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'whatsapp';
ALTER TABLE cases ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'whatsapp';
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'whatsapp';

-- Backfill existing rows
UPDATE clients SET source = 'whatsapp' WHERE source IS NULL;
UPDATE cases SET source = 'whatsapp' WHERE source IS NULL;
UPDATE invoices SET source = 'whatsapp' WHERE source IS NULL;

SELECT 'Migration 20250715_simulator_source completed successfully' AS status;
