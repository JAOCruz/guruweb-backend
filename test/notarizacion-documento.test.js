// Captura 21 de Leandro (2026-11-27): solo notarizar un documento que el cliente ya trae (contrato de arrendamiento,
// declaración jurada…) sale en RD$700 y el precio admite hasta 2 originales o copias por documento.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const { calculatePrice } = require('../src/models/servicePricing');

const MIG = 'migrations/20261127_notarizacion_documento.sql';
const NAME = 'Notarización de Documento (solo notarizar)';

test.before(async () => {
  await createAgentSchema();
  await pool.query('ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS fojas INT, ADD COLUMN IF NOT EXISTS foja_tipo TEXT');
  await pool.query(`INSERT INTO service_categories (name) VALUES ('Notarización')`);
  await runSqlFile(MIG);
  await runSqlFile(MIG); // idempotente
});
test.after(() => pool.end());

test('solo notarizar un documento que no es venta: RD$700, con hasta 2 originales incluidos', async () => {
  const { rows } = await pool.query('SELECT * FROM service_catalog WHERE name = $1', [NAME]);
  assert.equal(rows.length, 1);
  const s = rows[0];
  assert.equal(s.active, true);
  assert.equal(calculatePrice(s).total, 700);
  assert.match(s.incluye, /hasta 2 originales o copias/);
  assert.match(s.reglas, /más de 2/);
  for (const a of ['notarizar declaracion jurada', 'notarizar contrato de arrendamiento']) assert.ok(s.alias.includes(a), a);
  // el tercer ejemplar es un duplicado (1 foja = 500)
  assert.equal(calculatePrice(s, { duplicados: 1 }).total, 1200);
});
