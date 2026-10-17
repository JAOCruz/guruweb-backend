// Chat asignado: el bot se calla y, si nadie responde en 20 min de horario, se avisa al admin.
process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-assign-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const { clearCache } = require('../src/agent/businessInfo');
const { generateToken } = require('../src/middleware/auth');
const handler = require('../src/whatsapp/handler');
const { chatAssigned, chatUnassigned, checkUnattended } = require('../src/services/chatAssignment');

const PHONE = '18095550222';
// 2026-10-05 es lunes; 13:00Z = 9:00 en Santo Domingo (abre). 02:00Z del martes = 22:00 del lunes (cerrado).
const MON_0900 = new Date('2026-10-05T13:00:00Z');
const plus = (d, min) => new Date(d.getTime() + min * 60000);
let adminId, digId, clientId, server, base, tok;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/clients', require('../src/routes/clients'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await createAgentSchema();
  await runSqlFile('migrations/20261017_reglas_atencion.sql');
  clearCache();
  adminId = await createUser('leandro', 'admin', 'Leandro');
  digId = await createUser('hengi', 'digitador', 'Hengi');
  tok = generateToken({ id: adminId, username: 'leandro', email: 'l@t.co', role: 'admin' });
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Ana Cliente') RETURNING id`, [PHONE])).rows[0].id;
  handler.setManualMode(PHONE, false);
});
test.after(async () => { server.close(); await pool.end(); });

const alarms = async () => (await pool.query(`SELECT user_id, title, message, link FROM notifications WHERE type = 'unattended' ORDER BY id`)).rows;
const assignNow = async (at) => {
  await pool.query('UPDATE clients SET assigned_to = $1 WHERE id = $2', [digId, clientId]);
  await chatAssigned(PHONE, digId, at);
};

test('asignar por la ruta pone el chat en manual y guarda la asignación', async () => {
  const res = await fetch(`${base}/api/clients/${clientId}/assign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify({ user_id: digId }),
  });
  assert.equal(res.status, 200);
  assert.equal(handler.isManualMode(PHONE), true);
  const st = (await pool.query(`SELECT value FROM wa_bot_state WHERE key = $1`, [`assigned:${PHONE}`])).rows[0];
  assert.equal(st.value.user_id, digId);
  assert.equal(st.value.avisado, false);
});

test('quitar la asignación borra el estado pero no enciende el bot', async () => {
  await assignNow(MON_0900);
  await chatUnassigned(PHONE);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM wa_bot_state WHERE key = $1`, [`assigned:${PHONE}`])).rows[0].n, 0);
  assert.equal(handler.isManualMode(PHONE), true);
});

test('a los 19 min no avisa; a los 20 avisa una sola vez a los admins', async () => {
  await assignNow(MON_0900);
  assert.equal(await checkUnattended(plus(MON_0900, 19)), 0);
  assert.equal((await alarms()).length, 0);
  assert.equal(await checkUnattended(plus(MON_0900, 20)), 1);
  assert.equal(await checkUnattended(plus(MON_0900, 30)), 0);
  const a = await alarms();
  assert.equal(a.length, 1);
  assert.equal(a[0].user_id, adminId);
  assert.match(a[0].title, /Chat sin atender: Ana Cliente/);
  assert.match(a[0].message, /Hengi/);
  assert.equal(a[0].link, `/bot-messages?phone=${PHONE}`);
});

test('si alguien respondió después de asignar, no avisa', async () => {
  await assignNow(MON_0900);
  await pool.query(`INSERT INTO messages (phone, direction, content, created_at) VALUES ($1, 'outbound', 'Hola, le atiendo', $2)`, [PHONE, plus(MON_0900, 5)]);
  assert.equal(await checkUnattended(plus(MON_0900, 25)), 0);
});

test('un mensaje del cliente no cuenta como respuesta', async () => {
  await assignNow(MON_0900);
  await pool.query(`INSERT INTO messages (phone, direction, content, created_at) VALUES ($1, 'inbound', 'hola??', $2)`, [PHONE, plus(MON_0900, 5)]);
  assert.equal(await checkUnattended(plus(MON_0900, 25)), 1);
});

test('fuera de horario no cuenta: asignado de noche, avisa a los 20 min de abrir', async () => {
  const night = new Date('2026-10-06T02:00:00Z'); // lunes 22:00
  await assignNow(night);
  assert.equal(await checkUnattended(new Date('2026-10-06T12:00:00Z')), 0); // martes 8:00, cerrado
  assert.equal(await checkUnattended(new Date('2026-10-06T13:19:00Z')), 0); // 9:19
  assert.equal(await checkUnattended(new Date('2026-10-06T13:20:00Z')), 1); // 9:20
});

test('si el chat ya no está asignado a esa persona, no avisa', async () => {
  await assignNow(MON_0900);
  await pool.query('UPDATE clients SET assigned_to = NULL WHERE id = $1', [clientId]);
  assert.equal(await checkUnattended(plus(MON_0900, 25)), 0);
});
