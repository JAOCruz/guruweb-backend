-- Chats ocultos (solo el admin los ve). Si el contacto vuelve a escribir, el chat reaparece solo con lo nuevo.
CREATE TABLE IF NOT EXISTS hidden_chats (
  phone      TEXT PRIMARY KEY,
  hidden_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  hidden_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Empezar de 0 con el número real: se ocultan todos los chats que había al crear la tabla (nada se borra).
-- Solo si la tabla está vacía, para que volver a correrla no oculte chats nuevos.
INSERT INTO hidden_chats (phone)
SELECT phone FROM (
  SELECT phone FROM messages WHERE phone IS NOT NULL
  UNION
  SELECT phone FROM clients WHERE phone IS NOT NULL
) todos
WHERE NOT EXISTS (SELECT 1 FROM hidden_chats)
ON CONFLICT (phone) DO NOTHING;
