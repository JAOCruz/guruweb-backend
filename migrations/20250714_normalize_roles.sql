-- ============================================================
-- Normalize user roles for production
-- Date: 2025-07-14
-- Description:
--   - Extends users.role CHECK to support the real business roles:
--     admin, digitador, auxiliar.
--   - Keeps 'employee' for backward compatibility with legacy payroll data.
--   - Migrates any unknown roles to 'digitador'.
-- ============================================================

-- 1. Widen the role column if needed
ALTER TABLE users ALTER COLUMN role TYPE VARCHAR(30);

-- 2. Drop the old CHECK constraint if it exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_role_check' AND conrelid = 'users'::regclass
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_role_check;
  END IF;
END $$;

-- 3. Add the new CHECK constraint
ALTER TABLE users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('admin', 'digitador', 'auxiliar', 'employee'));

-- 4. Migrate any unknown roles to 'digitador' so existing users keep working
UPDATE users
SET role = 'digitador'
WHERE role NOT IN ('admin', 'digitador', 'auxiliar', 'employee');

-- 5. Migration complete
SELECT 'Migration 20250714_normalize_roles completed successfully' AS status;
