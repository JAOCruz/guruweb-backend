// Captura 02 de Leandro: la certificación de vehículo en Plan Piloto (gestión + impuesto aparte).
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const test = require('node:test');
const assert = require('node:assert/strict');

const MIG = 'migrations/20261028_certificacion_vehiculo_plan_piloto.sql';

test.before(async () => {
  await createAgentSchema();
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS requisitos TEXT`);
  await pool.query(`INSERT INTO service_categories (name) VALUES ('Solicitud de Certificaciones')`);
});
test.after(() => pool.end());

test('agrega el servicio con su precio, sus requisitos y sin montos en las reglas; correrla dos veces no lo repite', async () => {
  await runSqlFile(MIG);
  await runSqlFile(MIG);
  const rows = (await pool.query(`SELECT s.*, c.name AS cat FROM service_catalog s JOIN service_categories c ON c.id = s.category_id
    WHERE s.name = 'Certificación de Vehículo (Plan Piloto)'`)).rows;
  assert.equal(rows.length, 1);
  const [s] = rows;
  assert.equal(Number(s.digitacion_price), 500);
  assert.equal(s.cat, 'Solicitud de Certificaciones');
  assert.match(s.reglas, /impuesto/);
  assert.match(s.reglas, /cédula del propietario/);
  assert.match(s.reglas, /matrícula/);
  assert.doesNotMatch(s.reglas, /RD\$|\d{3}/, 'los montos viven en las columnas de precio');
  assert.ok(s.alias.includes('plan piloto'));
});
