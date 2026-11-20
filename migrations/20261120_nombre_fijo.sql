-- El nombre que el equipo le pone a un cliente queda fijo: el nombre de perfil de WhatsApp ya no lo pisa.
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS name_locked BOOLEAN NOT NULL DEFAULT false;
