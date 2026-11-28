-- A qué mensaje de WhatsApp responde este (context.id de Meta). El chat del panel lo muestra como en WhatsApp:
-- una miniatura del mensaje citado que lleva a él con un clic. Idempotente.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reply_to_wa_message_id VARCHAR(255);

SELECT 'Migration 20261128_messages_reply_to completed successfully' AS status;
