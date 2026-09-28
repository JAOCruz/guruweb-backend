const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { generateToken } = require('../src/middleware/auth');

const MIG = 'migrations/20260928_avatar_settings.sql';
let server, base, tok = {}, ids = {};

test.before(async () => {
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Leandro','admin'), ('hengi','hengi@x.com','x','Hengi','digitador'),
    ('marleni','marleni@x.com','x','Marleni','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query('DROP TABLE IF EXISTS avatar_settings');
  await runSqlFile(MIG);
  await runSqlFile(MIG); // idempotent
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) {
    tok[u.username] = generateToken(u);
    ids[u.username] = u.id;
  }
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/admin', require('../src/routes/admin'));
  app.use('/api/dashboard', require('../src/routes/dashboard'));
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
const enabled = async (who = 'hengi') => (await (await call('GET', '/api/dashboard/avatars', who)).json()).enabled;

test('the migration enables the 24 original faces; everyone can read the list', async () => {
  const list = await enabled();
  assert.equal(list.length, 24);
  assert.ok(list.includes('cow'));
  assert.ok(!list.includes('sheep'));
});

test('an employee cannot pick a disabled animal', async () => {
  const res = await call('PUT', '/api/auth/me/appearance', 'hengi', { avatar: 'sheep' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'AVATAR_DISABLED');
});

test('only the admin enables animals; then employees can pick them', async () => {
  assert.equal((await call('PUT', '/api/admin/avatars/sheep', 'hengi', { enabled: true })).status, 403);
  const res = await call('PUT', '/api/admin/avatars/sheep', 'admin', { enabled: true, label: 'Oveja' });
  assert.equal(res.status, 200);
  assert.ok((await enabled()).includes('sheep'));
  assert.equal((await call('PUT', '/api/auth/me/appearance', 'hengi', { avatar: 'sheep' })).status, 200);
  const log = (await pool.query(`SELECT summary FROM activity_log WHERE action = 'avatar.enable' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.match(log.summary, /Activó el animal «Oveja»/);
});

test('disabling keeps it for whoever has it, but nobody else can pick it', async () => {
  assert.equal((await call('PUT', '/api/admin/avatars/sheep', 'admin', { enabled: false })).status, 200);
  assert.ok(!(await enabled()).includes('sheep'));
  const me = (await (await call('GET', '/api/auth/me', 'hengi')).json()).user;
  assert.equal(me.avatar, 'sheep');
  // Hengi can still save other changes while keeping it
  assert.equal((await call('PUT', '/api/auth/me/appearance', 'hengi', { avatar: 'sheep', color: 'teal' })).status, 200);
  const other = await call('PUT', '/api/auth/me/appearance', 'marleni', { avatar: 'sheep' });
  assert.equal((await other.json()).code, 'AVATAR_DISABLED');
});

test('the admin can use any animal, and the owl cannot be toggled', async () => {
  assert.equal((await call('PUT', '/api/auth/me/appearance', 'admin', { avatar: 'elephant' })).status, 200);
  assert.equal((await call('PUT', '/api/admin/avatars/owl', 'admin', { enabled: true })).status, 400);
  assert.equal((await call('PUT', '/api/admin/avatars/dinosaurio', 'admin', { enabled: true })).status, 400);
  assert.equal((await call('PUT', '/api/admin/avatars/goat', 'admin', { enabled: 'yes' })).status, 400);
});
