const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { generateToken, authenticate, invalidateUserStatus } = require('../src/middleware/auth');

let server, base, tok = {};

test.before(async () => {
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('ana','ana@x.com','x','Ana','digitador'), ('temp','temp@x.com','x','Temp','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await runSqlFile('migrations/20260927_birth_date.sql');
  await pool.query(`UPDATE users SET must_change_password = TRUE WHERE username = 'temp'`);
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) tok[u.username] = { id: u.id, t: generateToken(u) };

  const app = express();
  app.use(cookieParser());
  app.get('/api/auth/me', authenticate, (req, res) => res.json({ ok: true }));
  app.put('/api/auth/change-password', authenticate, (req, res) => res.json({ ok: true }));
  app.get('/api/things', authenticate, (req, res) => res.json({ ok: true }));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

const get = (path, who, method = 'GET') => fetch(base + path, { method, headers: { Authorization: `Bearer ${tok[who].t}` } });

test('active user passes', async () => {
  assert.equal((await get('/api/things', 'ana')).status, 200);
});

test('deactivated user is rejected with USER_INACTIVE once cache is invalidated', async () => {
  await pool.query(`UPDATE users SET is_active = FALSE WHERE username = 'ana'`);
  invalidateUserStatus(tok.ana.id);
  const res = await get('/api/things', 'ana');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, 'USER_INACTIVE');
  await pool.query(`UPDATE users SET is_active = TRUE WHERE username = 'ana'`);
  invalidateUserStatus(tok.ana.id);
});

test('pending password change blocks other endpoints', async () => {
  const res = await get('/api/things', 'temp');
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'PASSWORD_CHANGE_REQUIRED');
});

test('pending password change still allows /me and change-password', async () => {
  assert.equal((await get('/api/auth/me', 'temp')).status, 200);
  assert.equal((await get('/api/auth/change-password', 'temp', 'PUT')).status, 200);
});

test('role comes from the database, not the token', async () => {
  const app2 = express();
  app2.use(cookieParser());
  app2.get('/whoami', authenticate, (req, res) => res.json({ role: req.user.role }));
  const srv = await new Promise((r) => { const x = app2.listen(0, () => r(x)); });
  try {
    await pool.query(`UPDATE users SET role = 'auxiliar' WHERE username = 'ana'`);
    invalidateUserStatus(tok.ana.id);
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/whoami`, { headers: { Authorization: `Bearer ${tok.ana.t}` } });
    assert.equal((await res.json()).role, 'auxiliar');
  } finally {
    srv.close();
  }
});
