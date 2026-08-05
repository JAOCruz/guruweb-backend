-- Marcar mensajes entrantes como leídos/no leídos para el badge de "mensajes nuevos"
-- del dashboard. Solo los inbound cuentan como no leídos; los outbound nacen leídos.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS read BOOLEAN NOT NULL DEFAULT FALSE;

-- Todos los mensajes existentes se consideran ya vistos, así el badge empieza en 0
-- y solo cuenta los mensajes NUEVOS que lleguen a partir de ahora.
UPDATE messages SET read = TRUE WHERE read = FALSE;

-- Índice para el conteo rápido de no leídos por teléfono.
CREATE INDEX IF NOT EXISTS idx_messages_read_phone ON messages(read, phone) WHERE direction = 'inbound';
