-- ============================================================
-- Case assignment history and status workflow
-- Date: 2025-07-14
-- Description:
--   - Adds case_assignment_history table to track who assigned
--     a case to whom and when.
--   - Adds client_assignment_history table for the same purpose
--     on clients.
--   - Adds a CHECK constraint on cases.status for the formal
--     workflow states.
-- ============================================================

-- 1. Case assignment history
CREATE TABLE IF NOT EXISTS case_assignment_history (
  id            SERIAL PRIMARY KEY,
  case_id       INT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  from_user_id  INT REFERENCES users(id) ON DELETE SET NULL,
  to_user_id    INT REFERENCES users(id) ON DELETE SET NULL,
  assigned_by   INT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at   TIMESTAMPTZ DEFAULT NOW(),
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_case_assignment_history_case ON case_assignment_history(case_id);
CREATE INDEX IF NOT EXISTS idx_case_assignment_history_to_user ON case_assignment_history(to_user_id);

-- 2. Client assignment history
CREATE TABLE IF NOT EXISTS client_assignment_history (
  id            SERIAL PRIMARY KEY,
  client_id     INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  from_user_id  INT REFERENCES users(id) ON DELETE SET NULL,
  to_user_id    INT REFERENCES users(id) ON DELETE SET NULL,
  assigned_by   INT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at   TIMESTAMPTZ DEFAULT NOW(),
  notes         TEXT
);

CREATE INDEX IF NOT EXISTS idx_client_assignment_history_client ON client_assignment_history(client_id);
CREATE INDEX IF NOT EXISTS idx_client_assignment_history_to_user ON client_assignment_history(to_user_id);

-- 3. Add formal status constraint (drop old if exists)
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
  CHECK (status IN ('open', 'in_progress', 'pending_payment', 'paid', 'closed', 'cancelled', 'escalated', 'resolved'));

-- Migration complete
SELECT 'Migration 20250714_case_assignment_history completed successfully' AS status;
