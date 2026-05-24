const pool = require('./pool');

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(255) UNIQUE,
    username      VARCHAR(50) UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    name          VARCHAR(255),
    role          VARCHAR(50) DEFAULT 'lawyer',
    data_column   VARCHAR(50),
    last_seen     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  );

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

  CREATE TABLE IF NOT EXISTS wa_sessions (
    id            SERIAL PRIMARY KEY,
    user_id       INT REFERENCES users(id) ON DELETE CASCADE,
    session_id    VARCHAR(255) UNIQUE NOT NULL,
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  );

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

  CREATE TABLE IF NOT EXISTS document_requests (
    id            SERIAL PRIMARY KEY,
    client_id     INT REFERENCES clients(id) ON DELETE CASCADE,
    case_id       INT REFERENCES cases(id) ON DELETE SET NULL,
    doc_type      VARCHAR(100) NOT NULL,
    description   TEXT,
    wa_media_id   VARCHAR(255),
    file_name     VARCHAR(255),
    mime_type     VARCHAR(100),
    status        VARCHAR(30) DEFAULT 'recibido',
    notes         TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
  CREATE INDEX IF NOT EXISTS idx_cases_client ON cases(client_id);
  CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
  CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
  CREATE INDEX IF NOT EXISTS idx_messages_client ON messages(client_id);
  CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id);
  CREATE INDEX IF NOT EXISTS idx_conv_sessions_phone ON conversation_sessions(phone);
  CREATE INDEX IF NOT EXISTS idx_conv_sessions_active ON conversation_sessions(active);
  CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);
  CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
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

  CREATE TABLE IF NOT EXISTS service_catalog (
    id            SERIAL PRIMARY KEY,
    name          VARCHAR(255) NOT NULL UNIQUE,
    description   TEXT,
    category_id   INT REFERENCES service_categories(id) ON DELETE SET NULL,
    digitacion_price DECIMAL(10, 2),
    notarizacion_price DECIMAL(10, 2),
    price_tiers   JSONB DEFAULT '[]',
    unit_type     VARCHAR(50) DEFAULT 'por documento',
    active        BOOLEAN DEFAULT true,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  );

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

  CREATE TABLE IF NOT EXISTS case_tags (
    id            SERIAL PRIMARY KEY,
    case_id       INT REFERENCES cases(id) ON DELETE CASCADE,
    tag_type      VARCHAR(100) NOT NULL,
    tag_value     VARCHAR(255) NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW()
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

  CREATE TABLE IF NOT EXISTS settings (
    id            SERIAL PRIMARY KEY,
    employee_percentage DECIMAL(5, 2) NOT NULL CHECK (employee_percentage >= 0 AND employee_percentage <= 100),
    effective_date DATE NOT NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_settings_effective_date ON settings(effective_date DESC);
  CREATE INDEX IF NOT EXISTS idx_service_categories_active ON service_categories(active);
  CREATE INDEX IF NOT EXISTS idx_service_catalog_category ON service_catalog(category_id);
  CREATE INDEX IF NOT EXISTS idx_service_catalog_active ON service_catalog(active);
  CREATE INDEX IF NOT EXISTS idx_client_services_client ON client_services(client_id);
  CREATE INDEX IF NOT EXISTS idx_client_services_service ON client_services(service_id);
  CREATE INDEX IF NOT EXISTS idx_case_tags_case ON case_tags(case_id);
`;

async function initDb() {
  try {
    await pool.query(schema);
    console.log('Database schema initialized successfully');
  } catch (err) {
    console.error('Failed to initialize database schema:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

initDb();
