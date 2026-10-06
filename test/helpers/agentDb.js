// Tablas mínimas para las pruebas del agente (herramientas, contexto y ciclo): usuarios (con 'bot'),
// clientes, ficha legal, catálogo, cotizaciones, casos, mensajes, medios, avisos, estado del bot
// y las tablas de la migración del agente. Cada prueba la llama en beforeEach.
const { pool, runSqlFile, resetDb } = require('./db');

async function createAgentSchema() {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS wa_bot_state, notifications, bot_tool_log, bot_memory, business_info, tramites, invoices,
    service_catalog, service_categories, legal_profiles, client_media, messages, cases, clients CASCADE`);
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, phone VARCHAR(20) UNIQUE, name VARCHAR(255), assigned_to INT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  await pool.query(`CREATE TABLE service_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, category_id INT, digitacion_price NUMERIC,
    notarizacion_price NUMERIC, price_tiers JSONB DEFAULT '[]', unit_type TEXT, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY, doc_number TEXT, type TEXT, status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_approval','approved','sent','rejected','paid')), client_id INT, case_id INT, client_name TEXT, client_phone TEXT,
    items JSONB, notes TEXT, subtotal NUMERIC, itbis NUMERIC, total NUMERIC, created_by INT, source TEXT, discount_type TEXT, discount_value NUMERIC,
    discount_code TEXT, discount_amount NUMERIC, discount_reason TEXT, approved_by INT, approved_at TIMESTAMPTZ, updated_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE cases (id SERIAL PRIMARY KEY, case_number TEXT, title TEXT, description TEXT, status TEXT DEFAULT 'new',
    case_type TEXT, client_id INT, user_id INT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), source TEXT, service_id INT)`);
  await pool.query(`CREATE TABLE messages (id SERIAL PRIMARY KEY, wa_message_id VARCHAR(255), phone VARCHAR(20), client_id INT, case_id INT,
    direction VARCHAR(10) NOT NULL, content TEXT NOT NULL, media_url TEXT, status VARCHAR(20) DEFAULT 'sent', wa_jid TEXT, push_name TEXT,
    read BOOLEAN DEFAULT false, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE client_media (id SERIAL PRIMARY KEY, phone VARCHAR(20) NOT NULL, client_id INT, wa_message_id VARCHAR(255),
    media_type VARCHAR(20) NOT NULL, mime_type VARCHAR(100), file_path TEXT NOT NULL)`);
  await pool.query(`CREATE TABLE notifications (id SERIAL PRIMARY KEY, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL, link TEXT, read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query('CREATE TABLE wa_bot_state (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)');
  await runSqlFile('migrations/20261005_bot_agent.sql');
  const botUserId = (await pool.query(`SELECT id FROM users WHERE username='bot'`)).rows[0].id;
  return { botUserId };
}

// Usuario del panel (admin o digitador) para los avisos.
async function createUser(username, role, name) {
  const { rows } = await pool.query(
    `INSERT INTO users (username, email, password_hash, name, role) VALUES ($1,$2,'x',$3,$4) RETURNING id`,
    [username, `${username}@t.co`, name, role]);
  return rows[0].id;
}

// Catálogo con un acto de venta por tramos: valor 500000 → 500 + 450 = 950.
async function seedCatalog() {
  await pool.query(`INSERT INTO service_categories (id, name) VALUES (1, 'Actos de venta') ON CONFLICT DO NOTHING`);
  const ins = async (name, { dig, not = null, tiers = [], pc = false, alias = [] }) => (await pool.query(
    `INSERT INTO service_catalog (name, category_id, digitacion_price, notarizacion_price, price_tiers, por_confirmar, alias)
     VALUES ($1,1,$2,$3,$4,$5,$6) RETURNING id`,
    [name, dig, not, JSON.stringify(tiers), pc, alias])).rows[0].id;
  return {
    acto: await ins('Acto de Venta - Vehículo Liviano', { dig: 500, not: 300, tiers: [{ min: 0, max: 1000000, price: 450 }], alias: ['traspaso', 'venta del carro'] }),
    poder: await ins('Poder', { dig: 700 }),
    conf: await ins('Estatus Jurídico', { dig: 1000, pc: true }),
  };
}

module.exports = { createAgentSchema, createUser, seedCatalog };
