-- ============================================================
-- Notifications system
-- Date: 2025-07-14
-- Description:
--   - Adds notifications table for complaints, assignments, etc.
-- ============================================================

CREATE TABLE IF NOT EXISTS notifications (
  id            SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          VARCHAR(50) NOT NULL, -- complaint, assignment, payment, system
  title         VARCHAR(255) NOT NULL,
  message       TEXT NOT NULL,
  link          TEXT,
  read          BOOLEAN DEFAULT false,
  read_at       TIMESTAMPTZ,
  metadata      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications(created_at DESC);

-- Migration complete
SELECT 'Migration 20250714_add_notifications completed successfully' AS status;
