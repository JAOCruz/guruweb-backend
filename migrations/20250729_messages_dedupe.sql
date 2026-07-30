-- Deduplicar mensajes: Baileys reenvía el mismo mensaje varias veces (reconexiones,
-- retries de media) y se guardaba cada vez, llegando a x45 duplicados del mismo
-- wa_message_id. Se limpian los duplicados existentes y se previene con unique index.

-- 1) Borrar duplicados existentes, manteniendo la fila más antigua (menor id) de cada wa_message_id
DELETE FROM messages a
USING messages b
WHERE a.wa_message_id IS NOT NULL
  AND a.wa_message_id = b.wa_message_id
  AND a.id > b.id;

-- 2) Unique index parcial (permite múltiples NULL para mensajes sin wa_message_id)
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_message_id_unique
ON messages(wa_message_id)
WHERE wa_message_id IS NOT NULL;
