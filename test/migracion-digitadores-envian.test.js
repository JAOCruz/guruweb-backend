// El switch de los digitadores queda encendido (Jay, 2026-10-31).
const { pool, runSqlFile } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

test('enciende «Los digitadores pueden aprobar y enviar documentos», con o sin la fila', async () => {
  await pool.query('DROP TABLE IF EXISTS business_info CASCADE');
  await pool.query('CREATE TABLE business_info (clave TEXT PRIMARY KEY, valor JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await runSqlFile('migrations/20261031_digitadores_envian.sql');
  const get = async () => (await pool.query(`SELECT valor FROM business_info WHERE clave = 'digitadores_aprueban_documentos'`)).rows[0].valor;
  assert.equal(await get(), true);
  await pool.query(`UPDATE business_info SET valor = 'false' WHERE clave = 'digitadores_aprueban_documentos'`);
  await runSqlFile('migrations/20261031_digitadores_envian.sql');
  assert.equal(await get(), true);
  await pool.end();
});
