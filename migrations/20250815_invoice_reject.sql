-- ============================================================
-- Invoice reject workflow
-- Date: 2025-08-15
-- Description:
--   - Adds rejected status metadata to invoices.
--   - Updates status check constraint to include 'rejected'.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'rejected_at'
  ) THEN
    ALTER TABLE invoices ADD COLUMN rejected_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'rejected_by'
  ) THEN
    ALTER TABLE invoices ADD COLUMN rejected_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'invoices_status_check' AND conrelid = 'invoices'::regclass
  ) THEN
    ALTER TABLE invoices DROP CONSTRAINT invoices_status_check;
  END IF;
END $$;

ALTER TABLE invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'approved', 'sent', 'paid', 'cancelled', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_invoices_rejected_by ON invoices(rejected_by);

SELECT 'Migration 20250815_invoice_reject completed successfully' AS status;
