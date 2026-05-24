-- ============================================================
-- Guru Dashboard Production Merge Migration
-- Date: 2025-05-23
-- Description: Adds all new dashboard tables while preserving
-- existing employee payroll (users, services, settings)
-- ============================================================

-- ── 1. Alter users table for unified auth ──────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'email') THEN
    ALTER TABLE users ADD COLUMN email VARCHAR(255) UNIQUE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'name') THEN
    ALTER TABLE users ADD COLUMN name VARCHAR(255);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'updated_at') THEN
    ALTER TABLE users ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'last_seen') THEN
    ALTER TABLE users ADD COLUMN last_seen TIMESTAMPTZ;
  END IF;
  -- Make email/username nullable to support both login methods
  ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
END $$;

-- Backfill: copy username into email if email is null
UPDATE users SET email = username || '@guru.local' WHERE email IS NULL;

-- ── 2. Create settings table if missing ────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id            SERIAL PRIMARY KEY,
  employee_percentage DECIMAL(5, 2) NOT NULL CHECK (employee_percentage >= 0 AND employee_percentage <= 100),
  effective_date DATE NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_settings_effective_date ON settings(effective_date DESC);

-- Insert default 50/50 split if empty
INSERT INTO settings (employee_percentage, effective_date)
SELECT 50.00, CURRENT_DATE
WHERE NOT EXISTS (SELECT 1 FROM settings);

-- ── 3. Service Catalog (new table, separate from payroll services) ──
CREATE TABLE IF NOT EXISTS service_catalog (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL UNIQUE,
  description   TEXT,
  category_id   INT,
  digitacion_price DECIMAL(10, 2),
  notarizacion_price DECIMAL(10, 2),
  price_tiers   JSONB DEFAULT '[]',
  unit_type     VARCHAR(50) DEFAULT 'por documento',
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_catalog_category ON service_catalog(category_id);
CREATE INDEX IF NOT EXISTS idx_service_catalog_active ON service_catalog(active);

CREATE TABLE IF NOT EXISTS service_categories (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL UNIQUE,
  description   TEXT,
  abbreviation  VARCHAR(10),
  color         VARCHAR(20) DEFAULT '#3b82f6',
  icon          VARCHAR(50),
  category_type VARCHAR(20) CHECK (category_type IN ('service', 'product', 'store')) DEFAULT 'service',
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_service_categories_active ON service_categories(active);

-- ── 4. Bot / CRM tables ────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  phone         VARCHAR(20) UNIQUE NOT NULL,
  email         VARCHAR(255),
  address       TEXT,
  notes         TEXT,
  user_id       INT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);

CREATE TABLE IF NOT EXISTS cases (
  id            SERIAL PRIMARY KEY,
  case_number   VARCHAR(100) UNIQUE NOT NULL,
  title         VARCHAR(255) NOT NULL,
  description   TEXT,
  status        VARCHAR(50) DEFAULT 'open',
  case_type     VARCHAR(100),
  client_id     INT REFERENCES clients(id) ON DELETE CASCADE,
  user_id       INT REFERENCES users(id) ON DELETE SET NULL,
  court         VARCHAR(255),
  next_hearing  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cases_client ON cases(client_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

CREATE TABLE IF NOT EXISTS messages (
  id            SERIAL PRIMARY KEY,
  wa_message_id VARCHAR(255),
  phone         VARCHAR(20),
  client_id     INT REFERENCES clients(id) ON DELETE CASCADE,
  case_id       INT REFERENCES cases(id) ON DELETE SET NULL,
  direction     VARCHAR(10) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  content       TEXT NOT NULL,
  media_url     TEXT,
  status        VARCHAR(20) DEFAULT 'sent',
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id);
CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id);

CREATE TABLE IF NOT EXISTS conversation_sessions (
  id            SERIAL PRIMARY KEY,
  phone         VARCHAR(20) NOT NULL,
  client_id     INT REFERENCES clients(id) ON DELETE SET NULL,
  flow          VARCHAR(50) NOT NULL DEFAULT 'main_menu',
  step          VARCHAR(50) NOT NULL DEFAULT 'init',
  data          JSONB DEFAULT '{}',
  active        BOOLEAN DEFAULT true,
  expires_at    TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 minutes'),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_conv_sessions_phone ON conversation_sessions(phone);
CREATE INDEX IF NOT EXISTS idx_conv_sessions_active ON conversation_sessions(active);

CREATE TABLE IF NOT EXISTS appointments (
  id            SERIAL PRIMARY KEY,
  client_id     INT REFERENCES clients(id) ON DELETE CASCADE,
  case_id       INT REFERENCES cases(id) ON DELETE SET NULL,
  user_id       INT REFERENCES users(id) ON DELETE SET NULL,
  date          DATE NOT NULL,
  time          TIME NOT NULL,
  duration_min  INT DEFAULT 60,
  type          VARCHAR(50) DEFAULT 'consulta',
  status        VARCHAR(30) DEFAULT 'pendiente',
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);

CREATE TABLE IF NOT EXISTS document_requests (
  id            SERIAL PRIMARY KEY,
  client_id     INT REFERENCES clients(id) ON DELETE CASCADE,
  case_id       INT REFERENCES cases(id) ON DELETE SET NULL,
  doc_type      VARCHAR(100) NOT NULL,
  description   TEXT,
  wa_media_id   VARCHAR(255),
  file_name     VARCHAR(255),
  mime_type     VARCHAR(100),
  file_path     TEXT,
  status        VARCHAR(30) DEFAULT 'recibido',
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_document_requests_client ON document_requests(client_id);

CREATE TABLE IF NOT EXISTS client_media (
  id             SERIAL PRIMARY KEY,
  phone          VARCHAR(20) NOT NULL,
  client_id      INT REFERENCES clients(id) ON DELETE SET NULL,
  wa_message_id  VARCHAR(255),
  media_type     VARCHAR(20) NOT NULL,
  mime_type      VARCHAR(100),
  original_name  VARCHAR(255),
  saved_name     VARCHAR(255) NOT NULL,
  file_path      TEXT NOT NULL,
  file_size      INT,
  context        VARCHAR(50) DEFAULT 'conversation',
  doc_request_id INT REFERENCES document_requests(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_media_phone ON client_media(phone);
CREATE INDEX IF NOT EXISTS idx_client_media_client ON client_media(client_id);

CREATE TABLE IF NOT EXISTS client_services (
  id            SERIAL PRIMARY KEY,
  client_id     INT REFERENCES clients(id) ON DELETE CASCADE,
  service_id    INT REFERENCES service_catalog(id) ON DELETE CASCADE,
  status        VARCHAR(30) DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  started_at    TIMESTAMPTZ DEFAULT NOW(),
  completed_at  TIMESTAMPTZ,
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_services_client ON client_services(client_id);
CREATE INDEX IF NOT EXISTS idx_client_services_service ON client_services(service_id);

CREATE TABLE IF NOT EXISTS case_tags (
  id            SERIAL PRIMARY KEY,
  case_id       INT REFERENCES cases(id) ON DELETE CASCADE,
  tag_type      VARCHAR(100) NOT NULL,
  tag_value     VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_case_tags_case ON case_tags(case_id);

CREATE TABLE IF NOT EXISTS invoices (
  id            SERIAL PRIMARY KEY,
  client_id     INT REFERENCES clients(id) ON DELETE SET NULL,
  case_id       INT REFERENCES cases(id) ON DELETE SET NULL,
  invoice_number VARCHAR(100) UNIQUE NOT NULL,
  total         DECIMAL(12, 2) NOT NULL DEFAULT 0,
  status        VARCHAR(30) DEFAULT 'pendiente',
  notes         TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id            SERIAL PRIMARY KEY,
  invoice_id    INT REFERENCES invoices(id) ON DELETE CASCADE,
  service_id    INT REFERENCES service_catalog(id) ON DELETE SET NULL,
  description   VARCHAR(255) NOT NULL,
  quantity      INT NOT NULL DEFAULT 1,
  unit_price    DECIMAL(10, 2) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 5. WhatsApp tables ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS wa_sessions (
  id            SERIAL PRIMARY KEY,
  user_id       INT REFERENCES users(id) ON DELETE CASCADE,
  session_id    VARCHAR(255) UNIQUE NOT NULL,
  active        BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ── 6. Broadcasts ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS broadcasts (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  message       TEXT NOT NULL,
  recipients    JSONB DEFAULT '[]',
  status        VARCHAR(30) DEFAULT 'draft',
  scheduled_at  TIMESTAMPTZ,
  sent_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_broadcasts_status ON broadcasts(status);
CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduled ON broadcasts(scheduled_at);

-- ── 7. MotherBrain / Document Generation ───────────────────
CREATE TABLE IF NOT EXISTS doc_categories (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(100) NOT NULL UNIQUE,
  slug          VARCHAR(100) NOT NULL UNIQUE,
  parent_id     INTEGER REFERENCES doc_categories(id) ON DELETE SET NULL,
  description   TEXT,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS doc_templates (
  id            SERIAL PRIMARY KEY,
  category_id   INTEGER REFERENCES doc_categories(id) ON DELETE SET NULL,
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(255) NOT NULL,
  file_path     VARCHAR(500) NOT NULL,
  file_name     VARCHAR(255) NOT NULL,
  doc_type      VARCHAR(50) NOT NULL DEFAULT 'docx',
  is_active     BOOLEAN DEFAULT true,
  description   TEXT,
  required_roles JSONB DEFAULT '[]',
  estimated_price_min INTEGER,
  estimated_price_max INTEGER,
  sort_order    INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_templates_category ON doc_templates(category_id);
CREATE INDEX IF NOT EXISTS idx_doc_templates_active ON doc_templates(is_active);

CREATE TABLE IF NOT EXISTS doc_variables (
  id            SERIAL PRIMARY KEY,
  tag           VARCHAR(100) NOT NULL UNIQUE,
  description   TEXT,
  data_source   VARCHAR(100),
  format_expected VARCHAR(100),
  category      VARCHAR(50),
  is_rol_dynamic BOOLEAN DEFAULT false,
  rol_type      VARCHAR(50),
  validation_regex VARCHAR(255),
  example_value TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_variables_rol ON doc_variables(is_rol_dynamic);

CREATE TABLE IF NOT EXISTS doc_template_variables (
  id            SERIAL PRIMARY KEY,
  template_id   INTEGER NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,
  variable_id   INTEGER NOT NULL REFERENCES doc_variables(id) ON DELETE CASCADE,
  is_required   BOOLEAN DEFAULT true,
  sort_order    INTEGER DEFAULT 0,
  UNIQUE(template_id, variable_id)
);

CREATE TABLE IF NOT EXISTS doc_generation_sessions (
  id            SERIAL PRIMARY KEY,
  template_id   INTEGER NOT NULL REFERENCES doc_templates(id),
  client_id     INTEGER REFERENCES clients(id) ON DELETE SET NULL,
  phone         VARCHAR(50),
  status        VARCHAR(50) NOT NULL DEFAULT 'collecting',
  collected_data JSONB DEFAULT '{}',
  assigned_roles JSONB DEFAULT '{}',
  generated_file_path VARCHAR(500),
  generated_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_doc_sessions_status ON doc_generation_sessions(status);
CREATE INDEX IF NOT EXISTS idx_doc_sessions_phone ON doc_generation_sessions(phone);

CREATE TABLE IF NOT EXISTS doc_roles (
  id            SERIAL PRIMARY KEY,
  code          VARCHAR(50) NOT NULL UNIQUE,
  name          VARCHAR(100) NOT NULL,
  name_es       VARCHAR(100) NOT NULL,
  category      VARCHAR(50),
  description   TEXT,
  is_active     BOOLEAN DEFAULT true,
  sort_order    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS service_procedures (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  slug          VARCHAR(255) NOT NULL UNIQUE,
  category      VARCHAR(100),
  steps         JSONB DEFAULT '[]',
  estimated_cost_min INTEGER,
  estimated_cost_max INTEGER,
  estimated_days_min INTEGER,
  estimated_days_max INTEGER,
  required_documents JSONB DEFAULT '[]',
  notes         TEXT,
  is_active     BOOLEAN DEFAULT true
);

-- ── 8. Laws ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS law_categories (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL UNIQUE,
  description   TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS laws (
  id            SERIAL PRIMARY KEY,
  category_id   INT REFERENCES law_categories(id) ON DELETE SET NULL,
  title         VARCHAR(255) NOT NULL,
  content       TEXT NOT NULL,
  reference     VARCHAR(255),
  tags          JSONB DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_laws_category ON laws(category_id);

-- Migration complete
SELECT 'Migration 20250523_merge_dashboard completed successfully' AS status;
