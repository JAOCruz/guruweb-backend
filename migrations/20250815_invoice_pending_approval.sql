-- ============================================================
-- Invoice pending approval workflow
-- Date: 2025-08-15
-- Description:
--   - Adds 'pending_approval' status for employee invoices that
--     need admin review before being sent.
-- ============================================================

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
  CHECK (status IN ('draft', 'approved', 'sent', 'paid', 'cancelled', 'rejected', 'pending_approval'));

CREATE INDEX IF NOT EXISTS idx_invoices_status_pending ON invoices(status) WHERE status = 'pending_approval';

SELECT 'Migration 20250815_invoice_pending_approval completed successfully' AS status;
