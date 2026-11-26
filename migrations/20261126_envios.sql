-- Envíos: documentos que se mandan al cliente (por Uber). El bot recoge los datos y el dashboard los organiza por
-- estado. Sin montos: el pago lo maneja el equipo por fuera. Idempotente.
CREATE TABLE IF NOT EXISTS deliveries (
  id SERIAL PRIMARY KEY,
  client_id INT REFERENCES clients(id) ON DELETE SET NULL,
  case_id INT REFERENCES cases(id) ON DELETE SET NULL,
  document TEXT,
  address TEXT NOT NULL,
  reference TEXT,
  recipient_name TEXT,
  recipient_phone VARCHAR(40),
  note TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'por_enviar'
    CHECK (status IN ('por_enviar', 'enviado', 'entregado', 'cancelado')),
  source VARCHAR(20) NOT NULL DEFAULT 'whatsapp',
  created_by INT REFERENCES users(id) ON DELETE SET NULL,
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS deliveries_status_idx ON deliveries (status, created_at DESC);
CREATE INDEX IF NOT EXISTS deliveries_client_idx ON deliveries (client_id);
