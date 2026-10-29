// Leandro, 2026-10-29 (sobre la captura 02): hay dos certificaciones de vehículo. La básica (verificación en la Policía
// Nacional o el CERNAVE, RD$500 + impuestos) y la Verificación de Vehículo para fines de Traspaso (DGII, RD$1,000 +
// impuestos, opcional y más avanzada). El bot pregunta cuál quiere. La cita se pide con 24 a 48 horas, pero no literal.
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const test = require('node:test');
const assert = require('node:assert/strict');

const BASICA = 'Certificación de Vehículo (Plan Piloto)';
const TRASPASO = 'Verificación de Vehículo para fines de Traspaso (DGII)';

test.before(async () => {
  await createAgentSchema();
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS requisitos TEXT`);
  await pool.query(`INSERT INTO service_categories (name) VALUES ('Solicitud de Certificaciones')`);
  await runSqlFile('migrations/20261028_certificacion_vehiculo_plan_piloto.sql');
  await runSqlFile('migrations/20261029_verificacion_vehiculo.sql');
  await runSqlFile('migrations/20261029_verificacion_vehiculo.sql'); // idempotente
});
test.after(() => pool.end());

const one = async (name) => (await pool.query(`SELECT s.*, c.name AS cat FROM service_catalog s
  JOIN service_categories c ON c.id = s.category_id WHERE s.name = $1`, [name])).rows;

test('la básica sigue en RD$500, pregunta cuál de las dos y la cita no es literal a 48 horas', async () => {
  const [s] = await one(BASICA);
  assert.equal(Number(s.digitacion_price), 500);
  assert.match(s.reglas, /CERNAVE/);
  assert.match(s.reglas, /Traspaso/);
  assert.match(s.reglas, /24 a 48 horas/);
  assert.doesNotMatch(s.reglas, /Solo se reciben solicitudes con 48 horas/);
  assert.match(s.reglas, /impuesto/);
  assert.doesNotMatch(s.reglas, /RD\$|\d{3}/, 'los montos viven en las columnas de precio');
  for (const al of ['verificacion de vehiculo', 'cernave', 'certificacion de vehiculo']) assert.ok(s.alias.includes(al), al);
  assert.equal(new Set(s.alias).size, s.alias.length);
});

test('la de traspaso: RD$1,000 + impuestos, opcional, en la misma categoría y una sola vez', async () => {
  const rows = await one(TRASPASO);
  assert.equal(rows.length, 1);
  const [s] = rows;
  assert.equal(Number(s.digitacion_price), 1000);
  assert.equal(s.cat, 'Solicitud de Certificaciones');
  assert.equal(s.notarizacion, 'no_aplica');
  assert.match(s.reglas, /opcional/);
  assert.match(s.reglas, /impuesto/);
  assert.match(s.reglas, /DGII/);
  assert.doesNotMatch(s.reglas, /RD\$|\d{3}/);
  assert.ok(s.alias.includes('verificacion para traspaso'));
});
