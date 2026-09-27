const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {};

test.before(async () => {
  await resetDb();
  const hash = await bcrypt.hash('secret1', 4);
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com',$1,'Admin','admin'), ('ana','ana@x.com',$1,'Ana','digitador'),
    ('temp','temp@x.com',$1,'Temp','digitador'), ('gone','gone@x.com',$1,'Gone','digitador')`, [hash]);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await runSqlFile('migrations/20260927_birth_date.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query(`UPDATE users SET must_change_password = TRUE WHERE username = 'temp'`);
  await pool.query(`UPDATE users SET is_active = FALSE WHERE username = 'gone'`);
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) tok[u.username] = generateToken(u);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../src/routes/auth'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, path, body, who) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tok[who]}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

test('deactivated user cannot log in', async () => {
  const res = await call('POST', '/api/auth/login', { username: 'gone', password: 'secret1' });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: 'Usuario desactivado. Contacta al administrador.', code: 'USER_INACTIVE' });
});

test('login exposes mustChangePassword', async () => {
  const res = await call('POST', '/api/auth/login', { username: 'temp', password: 'secret1' });
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.equal(user.mustChangePassword, true);
  assert.equal(user.isActive, true);
});

test('changing the password clears the flag', async () => {
  const res = await call('PUT', '/api/auth/change-password', { currentPassword: 'secret1', newPassword: 'nueva123' }, 'temp');
  assert.equal(res.status, 200);
  const me = await (await call('GET', '/api/auth/me', null, 'temp')).json();
  assert.equal(me.user.mustChangePassword, false);
  const { rows } = await pool.query(`SELECT must_change_password FROM users WHERE username = 'temp'`);
  assert.equal(rows[0].must_change_password, false);
});

test('register requires an admin', async () => {
  const body = { email: 'n@x.com', password: 'Secreto2026', name: 'Nuevo', username: 'nuevo' };
  assert.equal((await call('POST', '/api/auth/register', body)).status, 401);
  assert.equal((await call('POST', '/api/auth/register', body, 'ana')).status, 403);
  assert.equal((await call('POST', '/api/auth/register', body, 'admin')).status, 201);
});

test('login is rejected when the human check fails', async () => {
  const turnstile = require('../src/services/turnstile');
  const original = turnstile.verifyTurnstile;
  turnstile.verifyTurnstile = async () => ({ ok: false });
  try {
    const res = await call('POST', '/api/auth/login', { username: 'ana', password: 'secret1', turnstileToken: 'bad' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Verificación de seguridad fallida. Intenta de nuevo.', code: 'CAPTCHA_FAILED' });
  } finally {
    turnstile.verifyTurnstile = original;
  }
});

test('login passes the token and client ip to the human check', async () => {
  const turnstile = require('../src/services/turnstile');
  const original = turnstile.verifyTurnstile;
  let seen;
  turnstile.verifyTurnstile = async (token, ip) => { seen = { token, ip }; return { ok: true }; };
  try {
    const res = await call('POST', '/api/auth/login', { username: 'ana', password: 'secret1', turnstileToken: 'good' });
    assert.equal(res.status, 200);
    assert.equal(seen.token, 'good');
    assert.ok(seen.ip);
  } finally {
    turnstile.verifyTurnstile = original;
  }
});

test('change-password rejects a weak new password', async () => {
  const res = await call('PUT', '/api/auth/change-password', { currentPassword: 'secret1', newPassword: 'password1' }, 'ana');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'WEAK_PASSWORD');
});

test('a failed login is recorded without changing the response', async () => {
  const res = await call('POST', '/api/auth/login', { username: 'ana', password: 'mala-clave-99' });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: 'Invalid credentials' });
  const { rows } = await pool.query(`SELECT category, action, summary, details FROM activity_log WHERE action = 'login.failed' ORDER BY id DESC LIMIT 1`);
  assert.equal(rows[0].category, 'seguridad');
  assert.match(rows[0].summary, /ana/);
  assert.equal(rows[0].details.password, undefined);
});

test('own password change is recorded', async () => {
  const { rows } = await pool.query(`SELECT category FROM activity_log WHERE action = 'user.password_change'`);
  assert.ok(rows.length >= 1);
  assert.equal(rows[0].category, 'usuarios');
});

test('unknown usernames are masked (people sometimes type their password there) and capped', async () => {
  const typed = 'MiClaveSecreta2026';
  await call('POST', '/api/auth/login', { username: typed, password: 'x' });
  const { rows } = await pool.query(`SELECT summary, details FROM activity_log WHERE action = 'login.failed' ORDER BY id DESC LIMIT 1`);
  assert.ok(!rows[0].summary.includes(typed));
  assert.ok(!JSON.stringify(rows[0].details).includes(typed));
  assert.match(rows[0].summary, /Mi…/);
});

test('a blocked login is recorded once per window, not on every blocked request', async () => {
  for (let i = 0; i < 9; i++) await call('POST', '/api/auth/login', { username: 'bloqueo_prueba', password: 'x' });
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM activity_log WHERE action = 'login.blocked'`);
  assert.equal(rows[0].n, 1);
});

test('admin reset-password follows the policy and is recorded', async () => {
  let res = await call('POST', '/api/auth/reset-password', { username: 'ana', newPassword: '123456' }, 'admin');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'WEAK_PASSWORD');
  res = await call('POST', '/api/auth/reset-password', { username: 'ana', newPassword: 'Nueva2026x' }, 'admin');
  assert.equal(res.status, 200);
  const { rows } = await pool.query(`SELECT category FROM activity_log WHERE action = 'user.password_reset'`);
  assert.equal(rows[0].category, 'usuarios');
});
