-- ============================================================
-- Case certifications workflow
-- Date: 2025-07-16
-- Description:
--   - Adds certification-related columns to cases.
--   - Widens cases.status check constraint to support certification
--     workflow states while keeping existing states valid.
--   - Creates case_status_history to track every status change.
--   - Creates case_reminders for due-date / deadline notifications.
-- ============================================================

-- 1. Add certification columns to cases
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS service_id INT REFERENCES service_catalog(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS institution VARCHAR(100),
  ADD COLUMN IF NOT EXISTS expected_completion_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS case_subtype VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_cases_service_id ON cases(service_id);
CREATE INDEX IF NOT EXISTS idx_cases_institution ON cases(institution);
CREATE INDEX IF NOT EXISTS idx_cases_case_subtype ON cases(case_subtype);
CREATE INDEX IF NOT EXISTS idx_cases_expected_completion_date ON cases(expected_completion_date);

-- 2. Update status check constraint (drop old if exists, add combined list)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'cases_status_check' AND conrelid = 'cases'::regclass
  ) THEN
    ALTER TABLE cases DROP CONSTRAINT cases_status_check;
  END IF;
END $$;

ALTER TABLE cases
  ADD CONSTRAINT cases_status_check
  CHECK (status IN (
    -- legacy states
    'open', 'in_progress', 'pending_payment', 'paid', 'resolved',
    -- certification / general workflow states
    'new', 'awaiting_institution', 'rejected', 'completed', 'delivered',
    'closed', 'cancelled', 'escalated'
  ));

-- 3. Status history table
CREATE TABLE IF NOT EXISTS case_status_history (
  id                SERIAL PRIMARY KEY,
  case_id           INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  status            VARCHAR(50) NOT NULL,
  changed_by_user_id INT REFERENCES users(id) ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_status_history_case ON case_status_history(case_id);
CREATE INDEX IF NOT EXISTS idx_case_status_history_created ON case_status_history(created_at DESC);

-- 4. Reminders table
CREATE TABLE IF NOT EXISTS case_reminders (
  id                SERIAL PRIMARY KEY,
  case_id           INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  reminder_type     VARCHAR(50) NOT NULL,
  scheduled_at      TIMESTAMPTZ NOT NULL,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_reminders_case ON case_reminders(case_id);
CREATE INDEX IF NOT EXISTS idx_case_reminders_scheduled ON case_reminders(scheduled_at)
  WHERE sent_at IS NULL;

-- Migration complete
SELECT 'Migration 20250716_case_certifications completed successfully' AS status;
