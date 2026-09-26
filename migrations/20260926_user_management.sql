-- User management: active flag, forced password change, payroll membership. Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS in_payroll BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;

UPDATE users SET in_payroll = TRUE
WHERE UPPER(data_column) IN ('HENGI','MARLENI','ISRAEL','THAICAR','AUXILIAR_I','AUXILIAR_II')
  AND in_payroll = FALSE;

DO $$
BEGIN
  IF EXISTS (
    SELECT LOWER(username) FROM users WHERE username IS NOT NULL
    GROUP BY LOWER(username) HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate usernames (ignoring case) must be fixed before creating users_username_lower_unique';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_unique ON users (LOWER(username)) WHERE username IS NOT NULL;
