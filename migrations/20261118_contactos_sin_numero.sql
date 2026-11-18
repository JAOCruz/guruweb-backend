-- Contactos de WhatsApp con usuario (@nombre) que esconden su número: el chat se guarda con su código
-- de Meta (BSUID, hasta ~165 caracteres) en vez del teléfono. Se agrandan las columnas de teléfono.
ALTER TABLE IF EXISTS clients               ALTER COLUMN phone TYPE VARCHAR(200);
ALTER TABLE IF EXISTS messages              ALTER COLUMN phone TYPE VARCHAR(200);
ALTER TABLE IF EXISTS client_media          ALTER COLUMN phone TYPE VARCHAR(200);
ALTER TABLE IF EXISTS conversation_sessions ALTER COLUMN phone TYPE VARCHAR(200);
