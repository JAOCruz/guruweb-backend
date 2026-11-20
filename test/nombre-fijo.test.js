// El nombre que el equipo le pone a un cliente queda fijo: el nombre de perfil de WhatsApp ya no lo pisa.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-nombrefijo-'));

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const { generateToken } = require('../src/middleware/auth');
const Client = require('../src/models/Client');

const MIGRATION = 'migrations/20261120_nombre_fijo.sql';
const RARO = '✨Juanito El Bendecido De Dios 🙏✨';
let server, base, tok;

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
  await runSqlFile(MIGRATION);
  const adminId = await createUser('leandro', 'admin', 'Leandro');
  tok = generateToken({ id: adminId, username: 'leandro', email: 'leandro@t.co', role: 'admin' });
});
test.after(async () => { server.close(); await pool.end(); });

const send = (method, p, body) => fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: JSON.stringify(body) });
const nameOf = async (phone) => (await pool.query('SELECT name, name_locked FROM clients WHERE phone = $1', [phone])).rows[0];

test('la migración se puede correr dos veces y los clientes viejos quedan sin fijar', async () => {
  await pool.query(`INSERT INTO clients (phone, name) VALUES ('18095550001', 'Ana')`);
  await runSqlFile(MIGRATION);
  assert.equal((await nameOf('18095550001')).name_locked, false);
});

test('sin nombre fijo, el nombre de WhatsApp sigue llenando y mejorando el nombre (como antes)', async () => {
  await Client.updateOrCreatePushName('18095550002', 'Ana');
  assert.equal((await nameOf('18095550002')).name, 'Ana');
  await Client.updateOrCreatePushName('18095550002', 'Ana María Santos');
  assert.equal((await nameOf('18095550002')).name, 'Ana María Santos');
});

test('editar el nombre en el dashboard lo fija y el nombre de WhatsApp ya no lo cambia', async () => {
  const c = await Client.updateOrCreatePushName('18095550003', 'Juan');
  const res = await send('PUT', `/api/clients/${c.id}`, { name: 'Juan Pérez' });
  assert.equal(res.status, 200);
  assert.equal((await nameOf('18095550003')).name_locked, true);
  await Client.updateOrCreatePushName('18095550003', RARO);
  assert.equal((await nameOf('18095550003')).name, 'Juan Pérez');
});

test('editar otros datos sin tocar el nombre no lo fija', async () => {
  const c = await Client.updateOrCreatePushName('18095550004', 'Pedro');
  await send('PUT', `/api/clients/${c.id}`, { notes: 'Llama en la tarde' });
  assert.equal((await nameOf('18095550004')).name_locked, false);
});

test('crear el cliente desde el dashboard fija el nombre', async () => {
  const res = await send('POST', '/api/clients', { name: 'Carlos Mena', phone: '18095550005' });
  assert.equal(res.status, 201);
  await Client.updateOrCreatePushName('18095550005', RARO);
  assert.deepEqual(await nameOf('18095550005'), { name: 'Carlos Mena', name_locked: true });
});

test('Client.create con nameLocked lo guarda fijo; sin él queda sin fijar (bot)', async () => {
  await Client.create({ name: 'Rosa', phone: '18095550006', userId: null, nameLocked: true });
  await Client.create({ name: '18095550007', phone: '18095550007', userId: null });
  assert.equal((await nameOf('18095550006')).name_locked, true);
  assert.equal((await nameOf('18095550007')).name_locked, false);
});
