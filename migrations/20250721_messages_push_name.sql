-- Guardar el pushName de WhatsApp en cada mensaje entrante.
-- Permite mostrar el nombre real del contacto en el dashboard aunque no tenga
-- ficha de cliente (cubre los contactos @lid de privacidad, que hoy se ven como
-- un código numérico largo en vez de un nombre).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS push_name TEXT;

-- Índice para agrupar/buscar por nombre de contacto cuando no hay cliente.
CREATE INDEX IF NOT EXISTS idx_messages_push_name ON messages(push_name);
