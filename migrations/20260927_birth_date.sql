-- Optional birth date per user (set by an admin or by the user). Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_date DATE;
