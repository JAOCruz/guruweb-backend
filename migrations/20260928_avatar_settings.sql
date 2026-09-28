-- Which animals employees may pick (the admin toggles them). A key that is not here is disabled.
-- Idempotent; seeds the 24 original animal faces as enabled.
CREATE TABLE IF NOT EXISTS avatar_settings (
  key        VARCHAR(30) PRIMARY KEY,
  enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO avatar_settings (key, enabled)
SELECT k, TRUE FROM unnest(ARRAY[
  'cow', 'cat', 'dog', 'horse', 'pig', 'rabbit', 'rooster', 'lion', 'tiger', 'bear', 'panda', 'fox',
  'frog', 'giraffe', 'koala', 'monkey', 'hamster', 'mouse', 'wolf', 'boar', 'unicorn', 'dragon', 'raccoon', 'zebra'
]) AS k
ON CONFLICT (key) DO NOTHING;
