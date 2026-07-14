-- ============================================================
-- Invoice payment workflow
-- Date: 2025-07-14
-- Description:
--   - Adds 'paid' status to invoices.
--   - Re-adds case_id column to link invoices with cases.
--   - Adds payment metadata columns.
-- ============================================================

-- 1. Ensure case_id exists (it may have been dropped by a previous migration)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'case_id'
  ) THEN
    ALTER TABLE invoices ADD COLUMN case_id INT REFERENCES cases(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2. Add payment metadata columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'paid_at'
  ) THEN
    ALTER TABLE invoices ADD COLUMN paid_at TIMESTAMPTZ;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'paid_by'
  ) THEN
    ALTER TABLE invoices ADD COLUMN paid_by INT REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'payment_method'
  ) THEN
    ALTER TABLE invoices ADD COLUMN payment_method VARCHAR(50);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name = 'payment_reference'
  ) THEN
    ALTER TABLE invoices ADD COLUMN payment_reference VARCHAR(255);
  END IF;
END $$;

-- 3. Add CHECK constraint for invoice status including 'paid'
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
  CHECK (status IN ('draft', 'approved', 'sent', 'paid', 'cancelled'));

-- Migration complete
SELECT 'Migration 20250714_invoice_payment_workflow completed successfully' AS status;
