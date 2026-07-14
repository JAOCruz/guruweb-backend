-- Persistir estado y credenciales de WhatsApp en PostgreSQL
CREATE TABLE IF NOT EXISTS wa_bot_state (
  id SERIAL PRIMARY KEY,
  key VARCHAR(50) NOT NULL UNIQUE,
  value JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wa_credentials (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100) NOT NULL UNIQUE,
  creds JSONB NOT NULL DEFAULT '{}',
  keys JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_bot_state_key ON wa_bot_state(key);
CREATE INDEX IF NOT EXISTS idx_wa_credentials_session_id ON wa_credentials(session_id);

-- Trigger para actualizar updated_at en wa_credentials
CREATE OR REPLACE FUNCTION update_wa_credentials_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_wa_credentials_updated_at ON wa_credentials;
CREATE TRIGGER trg_wa_credentials_updated_at
  BEFORE UPDATE ON wa_credentials
  FOR EACH ROW
  EXECUTE FUNCTION update_wa_credentials_updated_at();
