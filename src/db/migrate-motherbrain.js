/**
 * Mother Brain Document Generation System — Database Migration
 * Creates tables for template management, dynamic ROL variables,
 * document generation sessions, and field collection tracking.
 */
const pool = require('./pool');

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 1. Document Categories ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS doc_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        slug VARCHAR(100) NOT NULL UNIQUE,
        parent_id INTEGER REFERENCES doc_categories(id) ON DELETE SET NULL,
        description TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 2. Document Templates ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS doc_templates (
        id SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES doc_categories(id) ON DELETE SET NULL,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        doc_type VARCHAR(50) NOT NULL DEFAULT 'docx',
        is_active BOOLEAN DEFAULT true,
        description TEXT,
        required_roles JSONB DEFAULT '[]',
        estimated_price_min INTEGER,
        estimated_price_max INTEGER,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 3. Template Variables (master dictionary) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS doc_variables (
        id SERIAL PRIMARY KEY,
        tag VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        data_source VARCHAR(100),
        format_expected VARCHAR(100),
        category VARCHAR(50),
        is_rol_dynamic BOOLEAN DEFAULT false,
        rol_type VARCHAR(50),
        validation_regex VARCHAR(255),
        example_value TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 4. Template ↔ Variable mappings ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS doc_template_variables (
        id SERIAL PRIMARY KEY,
        template_id INTEGER NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,
        variable_id INTEGER NOT NULL REFERENCES doc_variables(id) ON DELETE CASCADE,
        is_required BOOLEAN DEFAULT true,
        sort_order INTEGER DEFAULT 0,
        UNIQUE(template_id, variable_id)
      )
    `);

    // ── 5. Document Generation Sessions ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS doc_generation_sessions (
        id SERIAL PRIMARY KEY,
        template_id INTEGER NOT NULL REFERENCES doc_templates(id),
        client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
        phone VARCHAR(50),
        status VARCHAR(50) NOT NULL DEFAULT 'collecting',
        collected_data JSONB DEFAULT '{}',
        assigned_roles JSONB DEFAULT '{}',
        generated_file_path VARCHAR(500),
        generated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // ── 6. Role Definitions ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS doc_roles (
        id SERIAL PRIMARY KEY,
        code VARCHAR(50) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        name_es VARCHAR(100) NOT NULL,
        category VARCHAR(50),
        description TEXT,
        is_active BOOLEAN DEFAULT true,
        sort_order INTEGER DEFAULT 0
      )
    `);

    // ── 7. Service Procedure Index (from INDICE TRAMITES) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS service_procedures (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) NOT NULL UNIQUE,
        category VARCHAR(100),
        steps JSONB DEFAULT '[]',
        estimated_cost_min INTEGER,
        estimated_cost_max INTEGER,
        estimated_days_min INTEGER,
        estimated_days_max INTEGER,
        required_documents JSONB DEFAULT '[]',
        notes TEXT,
        is_active BOOLEAN DEFAULT true
      )
    `);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_doc_templates_category ON doc_templates(category_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_doc_templates_active ON doc_templates(is_active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_doc_variables_rol ON doc_variables(is_rol_dynamic)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_doc_sessions_status ON doc_generation_sessions(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_doc_sessions_phone ON doc_generation_sessions(phone)`);

    await client.query('COMMIT');
    console.log('[MotherBrain] ✅ Migration completed successfully');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[MotherBrain] ❌ Migration failed:', err.message);
    throw err;
  } finally {
    client.release();
  }
}

migrate().then(() => process.exit(0)).catch(() => process.exit(1));
