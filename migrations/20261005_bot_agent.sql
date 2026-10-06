-- Bot agente IA: columnas de catálogo, tablas del agente y usuario del bot. Idempotente.
ALTER TABLE service_catalog
  ADD COLUMN IF NOT EXISTS descripcion TEXT,
  ADD COLUMN IF NOT EXISTS incluye TEXT,
  ADD COLUMN IF NOT EXISTS reglas TEXT,
  ADD COLUMN IF NOT EXISTS requisitos TEXT,
  ADD COLUMN IF NOT EXISTS alias TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS notarizacion TEXT,
  ADD COLUMN IF NOT EXISTS template_id TEXT,
  ADD COLUMN IF NOT EXISTS tiempo_entrega TEXT,
  ADD COLUMN IF NOT EXISTS por_confirmar BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS precio_rango JSONB;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_catalog_notarizacion_check') THEN
    ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_notarizacion_check
      CHECK (notarizacion IN ('opcional','obligatoria','no_aplica'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS tramites (
  id SERIAL PRIMARY KEY,
  nombre TEXT UNIQUE NOT NULL,
  alias TEXT[] DEFAULT '{}',
  pasos JSONB NOT NULL DEFAULT '[]',
  preguntas_obligatorias TEXT[] DEFAULT '{}',
  reglas TEXT,
  activo BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS business_info (
  clave TEXT PRIMARY KEY,
  valor JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO business_info (clave, valor) VALUES
  ('horario', '{"dias":[1,2,3,4,5],"abre":"09:00","cierra":"18:00","zona":"America/Santo_Domingo"}'::jsonb),
  ('direccion', to_jsonb('Av. Independencia 1607, Santo Domingo'::text)),
  ('formas_pago', '["transferencia","efectivo"]'::jsonb),
  ('entregas', to_jsonb('Envío y recogida dentro del horario'::text)),
  ('mensaje_espera', to_jsonb($m$Un miembro de nuestro equipo se comunicará con usted a la brevedad. ⏰ Horario de atención: Lunes a Viernes, 9:00 a 18:00 hrs. Si su asunto es urgente fuera de horario, por favor indíquelo escribiendo 'urgente'.$m$::text)),
  ('trato', to_jsonb('usted'::text)),
  ('temas_humano', '["reclamaciones","pagos","reembolsos","asesoría legal","casos en tribunal"]'::jsonb)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS bot_memory (
  client_id INT PRIMARY KEY,
  resumen TEXT NOT NULL,
  hasta_mensaje_id INT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS bot_tool_log (
  id SERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  message_id INT,
  herramienta TEXT NOT NULL,
  args JSONB,
  resultado JSONB,
  ok BOOLEAN,
  ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bot_tool_log_phone_created ON bot_tool_log (phone, created_at);

-- Usuario del bot: is_active=false, nunca puede iniciar sesión.
INSERT INTO users (username, name, role, password_hash, is_active, in_payroll)
VALUES ('bot', 'Bot Gurú', 'digitador', '!', false, false)
ON CONFLICT DO NOTHING;
