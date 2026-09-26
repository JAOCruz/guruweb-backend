const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const { generateToken } = require('../src/middleware/auth');

let server, base, tokens = {};

test.before(async () => {
  await resetDb();
  const hash = await bcrypt.hash('secret1', 4);
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role, data_column) VALUES
    ('admin','admin@x.com',$1,'Admin','admin',NULL),
    ('hengi','hengi@x.com',$1,'Hengi','digitador','HENGI'),
    ('israel','israel@x.com',$1,'Israel','digitador','ISRAEL')`, [hash]);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  const { rows } = await pool.query('SELECT id, username, email, role FROM users');
  for (const u of rows) tokens[u.username] = generateToken(u);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/dashboard', require('../src/routes/dashboard'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { server.close(); await pool.end(); });

const call = (method, path, who, body) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });

test('PUT /me/appearance updates own color and avatar', async () => {
  const res = await call('PUT', '/api/auth/me/appearance', 'hengi', { color: 'blue', avatar: 'cow' });
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.equal(user.color, 'blue');
  assert.equal(user.avatar, 'cow');
  assert.equal(user.dataColumn, 'HENGI');
  assert.equal(user.password_hash, undefined);
});

test('taken color → 409 COLOR_TAKEN with Spanish message', async () => {
  const res = await call('PUT', '/api/auth/me/appearance', 'israel', { color: 'blue' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'Ese color lo acaba de tomar otro usuario', code: 'COLOR_TAKEN' });
});

test('taken avatar → 409 AVATAR_TAKEN', async () => {
  const res = await call('PUT', '/api/auth/me/appearance', 'israel', { avatar: 'cow' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'AVATAR_TAKEN');
});

test('employee asking for owl → 403', async () => {
  const res = await call('PUT', '/api/auth/me/appearance', 'israel', { avatar: 'owl' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'Reservado para el admin');
});

test('invalid color → 400', async () => {
  const res = await call('PUT', '/api/auth/me/appearance', 'israel', { color: 'magenta' });
  assert.equal(res.status, 400);
});

test('GET /me includes color and avatar', async () => {
  const res = await call('GET', '/api/auth/me', 'admin');
  const { user } = await res.json();
  assert.equal(user.avatar, 'owl');
  assert.ok(user.color);
});

test('GET /dashboard/users works for employees and exposes appearance', async () => {
  const res = await call('GET', '/api/dashboard/users', 'israel');
  assert.equal(res.status, 200);
  const { users } = await res.json();
  const hengi = users.find((u) => u.username === 'hengi');
  assert.equal(hengi.color, 'blue');
  assert.equal(hengi.avatar, 'cow');
  assert.equal(hengi.data_column, 'HENGI');
  assert.equal(hengi.password_hash, undefined);
});

test('change-password with wrong current → 400 (never 401)', async () => {
  const res = await call('PUT', '/api/auth/change-password', 'israel', { currentPassword: 'nope', newPassword: 'another1' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'La contraseña actual es incorrecta', code: 'WRONG_CURRENT_PASSWORD' });
});

test('change-password happy path', async () => {
  const res = await call('PUT', '/api/auth/change-password', 'israel', { currentPassword: 'secret1', newPassword: 'another1' });
  assert.equal(res.status, 200);
});
