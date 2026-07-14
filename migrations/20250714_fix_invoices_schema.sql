-- ============================================================
-- Fix invoices table schema to match src/models/Invoice.js
-- Date: 2025-07-14
-- Description: Adds the columns the backend expects, migrates
-- existing data, and drops the old invoice_number/case_id columns.
-- Safe to re-run.
-- ============================================================

DO $$
BEGIN
  -- Add columns expected by the backend code
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'doc_number') THEN
    ALTER TABLE invoices ADD COLUMN doc_number VARCHAR(100);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'type') THEN
    ALTER TABLE invoices ADD COLUMN type VARCHAR(50) DEFAULT 'COTIZACIÓN';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'client_name') THEN
    ALTER TABLE invoices ADD COLUMN client_name VARCHAR(255);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'client_phone') THEN
    ALTER TABLE invoices ADD COLUMN client_phone VARCHAR(50);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'items') THEN
    ALTER TABLE invoices ADD COLUMN items JSONB DEFAULT '[]';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'subtotal') THEN
    ALTER TABLE invoices ADD COLUMN subtotal DECIMAL(12, 2) DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'itbis') THEN
    ALTER TABLE invoices ADD COLUMN itbis DECIMAL(12, 2) DEFAULT 0;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'created_by') THEN
    ALTER TABLE invoices ADD COLUMN created_by INT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'approved_by') THEN
    ALTER TABLE invoices ADD COLUMN approved_by INT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'approved_at') THEN
    ALTER TABLE invoices ADD COLUMN approved_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'sent_at') THEN
    ALTER TABLE invoices ADD COLUMN sent_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'pdf_path') THEN
    ALTER TABLE invoices ADD COLUMN pdf_path TEXT;
  END IF;

  -- Backend expects status default 'draft'
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'status') THEN
    ALTER TABLE invoices ALTER COLUMN status SET DEFAULT 'draft';
  END IF;
END $$;

-- Align total column with expected schema (default 0, not strictly NOT NULL)
ALTER TABLE invoices ALTER COLUMN total SET DEFAULT 0;
ALTER TABLE invoices ALTER COLUMN total DROP NOT NULL;

-- ============================================================
-- Migrate existing data
-- ============================================================

-- Copy old invoice_number into the new doc_number field
UPDATE invoices
SET doc_number = invoice_number
WHERE doc_number IS NULL AND invoice_number IS NOT NULL;

-- All existing records are quotations
UPDATE invoices
SET type = 'COTIZACIÓN'
WHERE type IS NULL;

-- Normalize status to the workflow used by the backend (draft -> approved -> sent)
UPDATE invoices
SET status = 'draft'
WHERE status IS NULL
   OR status NOT IN ('draft', 'approved', 'sent');

-- Backfill numeric/JSON defaults
UPDATE invoices SET items    = '[]'::jsonb WHERE items IS NULL;
UPDATE invoices SET subtotal = 0           WHERE subtotal IS NULL;
UPDATE invoices SET itbis    = 0           WHERE itbis IS NULL;

-- Pull client name/phone from clients when available
UPDATE invoices i
SET client_name = c.name,
    client_phone = c.phone
FROM clients c
WHERE i.client_id = c.id
  AND (i.client_name IS NULL OR i.client_phone IS NULL);

-- Assign creator to the first admin user when unknown
UPDATE invoices
SET created_by = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
WHERE created_by IS NULL
  AND EXISTS (SELECT 1 FROM users WHERE role = 'admin');

-- ============================================================
-- Add constraints and indexes
-- ============================================================

-- doc_number is the new required unique identifier
ALTER TABLE invoices ALTER COLUMN doc_number SET NOT NULL;

DO $$
BEGIN
  -- Unique doc_number constraint
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_invoices_doc_number'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT uq_invoices_doc_number UNIQUE (doc_number);
  END IF;

  -- Foreign keys to users
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_created_by'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoices_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'fk_invoices_approved_by'
  ) THEN
    ALTER TABLE invoices ADD CONSTRAINT fk_invoices_approved_by FOREIGN KEY (approved_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ============================================================
-- Remove obsolete columns
-- ============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'invoice_number') THEN
    ALTER TABLE invoices DROP COLUMN invoice_number;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invoices' AND column_name = 'case_id') THEN
    ALTER TABLE invoices DROP COLUMN case_id;
  END IF;
END $$;

-- Indexes for the common query patterns
CREATE INDEX IF NOT EXISTS idx_invoices_type       ON invoices(type);
CREATE INDEX IF NOT EXISTS idx_invoices_status     ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_client_id  ON invoices(client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_created_by ON invoices(created_by);

-- Migration complete
SELECT 'Migration 20250714_fix_invoices_schema completed successfully' AS status;
