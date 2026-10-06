#!/usr/bin/env node
// Exporta el catálogo (solo lectura) a test/agent/catalog-snapshot.json.
// Solo SELECT. Nunca imprime la URL de la base de datos. No exporta clientes,
// mensajes ni usuarios: solo service_categories, service_catalog y tramites.
//
// Uso: node scripts/export-catalog.js  (lee DATABASE_URL del entorno o de .env)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUT = path.join(__dirname, '..', 'test', 'agent', 'catalog-snapshot.json');
const ALLOWED_TABLES = ['service_categories', 'service_catalog', 'tramites'];

async function columns(client, table) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table]
  );
  return r.rows.map((x) => x.column_name);
}

async function exportCatalog() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL no está definida');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const snapshot = { exported_at: new Date().toISOString(), service_categories: [], service_catalog: [], tramites: [] };
    for (const table of ALLOWED_TABLES) {
      const cols = await columns(client, table);
      if (!cols.length) continue; // la tabla no existe todavía (p. ej. tramites)
      const where = table === 'tramites'
        ? (cols.includes('activo') ? 'WHERE activo = true' : '')
        : (cols.includes('active') ? 'WHERE active = true' : '');
      const order = cols.includes('id') ? 'ORDER BY id' : '';
      const r = await client.query(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${table} ${where} ${order}`);
      snapshot[table] = r.rows;
    }
    await client.query('COMMIT');
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + '\n');
    return snapshot;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  exportCatalog()
    .then((s) => {
      console.log(`Snapshot: ${s.service_categories.length} categorías, ${s.service_catalog.length} servicios, ${s.tramites.length} trámites → ${path.relative(process.cwd(), OUT)}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('Export falló:', err.message);
      process.exit(1);
    });
}

module.exports = { exportCatalog };
