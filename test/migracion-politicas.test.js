// Leandro, 2026-10-26: políticas del negocio, precios del pagaré, el apoderado en la venta de vehículo
// y el seguimiento de cotizaciones (encendido, 24 h).
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const { formatForPrompt } = require('../src/agent/businessInfo');
const test = require('node:test');
const assert = require('node:assert/strict');

const MIG = 'migrations/20261027_politicas_seguimiento.sql';

test.beforeEach(async () => {
  await createAgentSchema();
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS fojas INT, ADD COLUMN IF NOT EXISTS foja_tipo TEXT`);
  await pool.query(`INSERT INTO service_categories (name) VALUES ('Redactar o digitar un documento')`);
  await pool.query(`INSERT INTO service_catalog (name, digitacion_price, notarizacion_price, reglas, notarizacion) VALUES
    ('Pagaré Notarial', 500, NULL, 'Incluye 1 original.', 'opcional'),
    ('Acto de Venta - Vehículo Liviano', 500, NULL, 'Pregunte el valor.', 'opcional'),
    ('Acto de Venta Condicional - Vehículo', 700, NULL, NULL, 'opcional'),
    ('Poder', 700, NULL, 'Sin cambios.', 'opcional')`);
});
test.after(() => pool.end());

const svc = async (name) => (await pool.query('SELECT * FROM service_catalog WHERE name = $1', [name])).rows;
const info = async () => Object.fromEntries((await pool.query('SELECT clave, valor FROM business_info')).rows.map((r) => [r.clave, r.valor]));

test('políticas, precios del pagaré, apoderado y seguimiento encendido', async () => {
  await runSqlFile(MIG);
  const [pagare] = await svc('Pagaré Notarial');
  assert.equal(Number(pagare.notarizacion_price), 1000);
  assert.ok(pagare.reglas.startsWith('Incluye 1 original. '), 'conserva lo que había');
  assert.match(pagare.reglas, /"desde"/);
  assert.doesNotMatch(pagare.reglas, /RD\$|\d{3}/, 'los montos viven en las columnas de precio');
  assert.match(pagare.reglas, /modelo/i);
  const [modelo] = await svc('Pagaré Notarial - Modelo (plantilla)');
  assert.equal(Number(modelo.digitacion_price), 300);
  assert.equal(modelo.notarizacion, 'no_aplica');
  assert.ok(modelo.alias.includes('modelo de pagare'));
  for (const name of ['Acto de Venta - Vehículo Liviano', 'Acto de Venta Condicional - Vehículo']) {
    assert.match((await svc(name))[0].reglas, /apoderado/i);
  }
  assert.equal((await svc('Poder'))[0].reglas, 'Sin cambios.');
  const bi = await info();
  assert.equal(bi.politicas.length, 4);
  assert.match(bi.politicas[0], /RE-PROCESAMIENTO/i);
  assert.deepEqual(bi.seguimiento_cotizaciones, { activo: true, horas: 24 });
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'invoices' AND column_name LIKE 'followup%' ORDER BY 1`)).rows;
  assert.deepEqual(cols.map((c) => c.column_name), ['followup_at', 'followup_error']);
  // el bot las tiene en su contexto
  assert.match(formatForPrompt(bi), /Políticas del negocio[^\n]*\n1\. Solo trabajamos con la información suministrada/);
});

test('correrla dos veces no repite nada, y no pisa un seguimiento que el admin apagó', async () => {
  await runSqlFile(MIG);
  const first = await svc('Pagaré Notarial');
  await pool.query(`UPDATE business_info SET valor = '{"activo": false, "horas": 24}' WHERE clave = 'seguimiento_cotizaciones'`);
  await runSqlFile(MIG);
  assert.deepEqual(await svc('Pagaré Notarial'), first);
  assert.equal((await svc('Pagaré Notarial - Modelo (plantilla)')).length, 1);
  assert.equal((await svc('Acto de Venta - Vehículo Liviano'))[0].reglas.match(/si nadie ha mencionado un apoderado/g).length, 1);
  assert.deepEqual((await info()).seguimiento_cotizaciones, { activo: false, horas: 24 });
});
