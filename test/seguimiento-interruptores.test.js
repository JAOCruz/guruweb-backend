// Interruptores del seguimiento de cotizaciones (Jay, 2026-11-27): el general lo cambia el admin desde el panel
// del bot; el de cada cliente, cualquiera del equipo desde el chat.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const { generateToken } = require('../src/middleware/auth');
const { clearCache, getBusinessInfo } = require('../src/agent/businessInfo');

let server, base, tok = {}, clientId;

test.before(async () => {
  await createAgentSchema();
  await pool.query('DROP TABLE IF EXISTS activity_log CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20261027_politicas_seguimiento.sql');
  await runSqlFile('migrations/20261127_seguimiento_interruptores.sql');
  await runSqlFile('migrations/20261127_seguimiento_interruptores.sql'); // idempotente
  for (const [u, role] of [['adm', 'admin'], ['dig', 'digitador']]) {
    const { rows } = await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES ($1,$2,'x',$1,$3) RETURNING id, username, email, role`, [u, `${u}@t.co`, role]);
    tok[u] = generateToken(rows[0]);
  }
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ('18095550001', 'Ana') RETURNING id`)).rows[0].id;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/settings', require('../src/routes/settings'));
  app.use('/api/clients', require('../src/routes/clients'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, p, who, body) =>
  fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });

test('interruptor general: todos lo leen, solo el admin lo cambia, y conserva las horas', async () => {
  let r = await (await call('GET', '/api/settings/seguimiento', 'dig')).json();
  assert.deepEqual(r, { activo: true, horas: 24 });
  assert.equal((await call('PUT', '/api/settings/seguimiento', 'dig', { activo: false })).status, 403);
  assert.equal((await call('PUT', '/api/settings/seguimiento', 'adm', { activo: 'no' })).status, 400);
  r = await (await call('PUT', '/api/settings/seguimiento', 'adm', { activo: false })).json();
  assert.deepEqual(r, { activo: false, horas: 24 });
  clearCache();
  assert.deepEqual((await getBusinessInfo()).seguimiento_cotizaciones, { activo: false, horas: 24 });
  const log = await pool.query(`SELECT summary FROM activity_log WHERE action = 'configuracion.seguimiento'`);
  assert.match(log.rows[0].summary, /Apagó el seguimiento/);
});

test('interruptor por cliente: cualquiera del equipo lo ve y lo cambia desde el chat', async () => {
  let r = await (await call('GET', `/api/clients/${clientId}/followup`, 'dig')).json();
  assert.deepEqual(r, { followup_off: false });
  assert.equal((await call('PUT', `/api/clients/${clientId}/followup`, 'dig', { followup_off: 'x' })).status, 400);
  r = await (await call('PUT', `/api/clients/${clientId}/followup`, 'dig', { followup_off: true })).json();
  assert.deepEqual(r, { followup_off: true });
  assert.equal((await pool.query('SELECT followup_off FROM clients WHERE id = $1', [clientId])).rows[0].followup_off, true);
  assert.equal((await call('GET', '/api/clients/99999/followup', 'dig')).status, 404);
  const log = await pool.query(`SELECT summary FROM activity_log WHERE action = 'client.followup'`);
  assert.match(log.rows[0].summary, /Apagó el seguimiento automático de Ana/);
});
