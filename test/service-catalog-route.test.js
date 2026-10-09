// Ruta /service-catalog: foja_tipo y fojas en el CRUD y en /calculate.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok, svcId;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/service-catalog', require('../src/routes/serviceCatalog'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await createAgentSchema();
  await pool.query('ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()');
  await pool.query('ALTER TABLE service_categories ADD COLUMN IF NOT EXISTS abbreviation TEXT, ADD COLUMN IF NOT EXISTS color TEXT');
  await runSqlFile('migrations/20261009_precios_leandro_1.sql');
  const adminId = await createUser('leandro', 'admin', 'Leandro');
  tok = generateToken({ id: adminId, username: 'leandro', email: 'leandro@t.co', role: 'admin' });
  svcId = (await pool.query(`INSERT INTO service_catalog (name, digitacion_price, price_tiers, foja_tipo, fojas)
    VALUES ('Carta Legal Simple', 100, '[]', 'legal_simple', 2) RETURNING id`)).rows[0].id;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, p, body) => fetch(base + p, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body && JSON.stringify(body),
});

test('PUT con foja_tipo inválido -> 400', async () => {
  assert.equal((await call('PUT', `/api/service-catalog/${svcId}`, { foja_tipo: 'otro' })).status, 400);
  assert.equal((await call('PUT', `/api/service-catalog/${svcId}`, { fojas: 0 })).status, 400);
  assert.equal((await call('PUT', `/api/service-catalog/${svcId}`, { fojas: 1.5 })).status, 400);
});
test('PUT con foja_tipo y fojas válidos guarda; null los quita', async () => {
  const res = await call('PUT', `/api/service-catalog/${svcId}`, { foja_tipo: 'carta_motivada', fojas: 2 });
  assert.equal(res.status, 200);
  const row = (await pool.query('SELECT foja_tipo, fojas FROM service_catalog WHERE id = $1', [svcId])).rows[0];
  assert.deepEqual(row, { foja_tipo: 'carta_motivada', fojas: 2 });
  assert.equal((await call('PUT', `/api/service-catalog/${svcId}`, { foja_tipo: null, fojas: null })).status, 200);
  const r2 = (await pool.query('SELECT foja_tipo, fojas FROM service_catalog WHERE id = $1', [svcId])).rows[0];
  assert.deepEqual(r2, { foja_tipo: null, fojas: null });
});
test('POST valida y guarda foja_tipo y fojas', async () => {
  assert.equal((await call('POST', '/api/service-catalog', { name: 'X', digitacion_price: 0, foja_tipo: 'zzz' })).status, 400);
  const res = await call('POST', '/api/service-catalog', { name: 'Carta nueva', digitacion_price: 0, foja_tipo: 'carta_simple', fojas: 1 });
  assert.equal(res.status, 201);
  const { service } = await res.json();
  assert.equal(service.foja_tipo, 'carta_simple');
  assert.equal(service.fojas, 1);
});
test('/calculate con fojas y duplicados', async () => {
  const res = await call('POST', '/api/service-catalog/calculate', { serviceId: svcId, fojas: 3, duplicados: 1 });
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.equal(b.total, 750 + 700);
  assert.equal(b.breakdown.duplicados, 700);
  assert.equal(b.fojas, 3);
  assert.equal(b.tarifaPorFoja, 250);
  assert.equal(b.fojasEstimadas, false);
  assert.equal(b.service.foja_tipo, 'legal_simple');
  assert.equal(b.service.fojas, 2);
  const est = await (await call('POST', '/api/service-catalog/calculate', { serviceId: svcId })).json();
  assert.equal(est.fojasEstimadas, true);
  assert.equal(est.total, 500);
});
