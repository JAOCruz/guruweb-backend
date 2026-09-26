-- Per-user color + avatar (keys; see src/config/appearance.js). Idempotent.
ALTER TABLE users ADD COLUMN IF NOT EXISTS color VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar VARCHAR(20);

CREATE UNIQUE INDEX IF NOT EXISTS users_color_unique ON users (color) WHERE color IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS users_avatar_unique ON users (avatar) WHERE avatar IS NOT NULL;

-- 1) Keep today's hardcoded colors
UPDATE users u SET color = s.color
FROM (VALUES ('HENGI','green'), ('MARLENI','yellow'), ('ISRAEL','red'),
             ('THAICAR','purple'), ('AUXILIAR_I','orange'), ('AUXILIAR_II','pink')) AS s(col, color)
WHERE UPPER(u.data_column) = s.col
  AND u.color IS NULL
  AND NOT EXISTS (SELECT 1 FROM users x WHERE x.color = s.color);

-- 2) Everyone else: first free palette color, in id order
DO $$
DECLARE
  palette TEXT[] := ARRAY['green','yellow','red','purple','orange','pink','teal','cyan','blue','indigo','lime','brown'];
  r RECORD;
  free_color TEXT;
BEGIN
  FOR r IN SELECT id FROM users WHERE color IS NULL ORDER BY id LOOP
    SELECT p.c INTO free_color
    FROM unnest(palette) WITH ORDINALITY AS p(c, ord)
    WHERE p.c NOT IN (SELECT color FROM users WHERE color IS NOT NULL)
    ORDER BY p.ord
    LIMIT 1;
    EXIT WHEN free_color IS NULL;
    UPDATE users SET color = free_color WHERE id = r.id;
  END LOOP;
END $$;

-- 3) Owl belongs to the main admin
UPDATE users SET avatar = 'owl'
WHERE id = (SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE avatar = 'owl');
