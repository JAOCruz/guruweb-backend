-- Add assigned_to column to clients table (used by digitador assignment feature)
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS assigned_to INT REFERENCES users(id) ON DELETE SET NULL;

-- Add last_seen column to users table (used by auth middleware)
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
