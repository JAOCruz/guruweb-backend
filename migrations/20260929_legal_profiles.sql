-- Documentos · Ficha legal: one reusable profile per client (cédula, nacionalidad, estado civil,
-- profesión, domicilio…). WhatsApp contacts are clients by phone, so they share it. Idempotent.
CREATE TABLE IF NOT EXISTS legal_profiles (
  client_id  INT PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_by INT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
