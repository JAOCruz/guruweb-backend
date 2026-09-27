const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { generateToken } = require('../src/middleware/auth');
const { normalizeBirthDate } = require('../src/config/birthDate');

const MIG = 'migrations/20260927_birth_date.sql';
let server, base, tok = {}, ids = {};

test.before(async () => {
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role, data_column) VALUES
    ('admin','admin@x.com','x','Admin','admin',NULL), ('hengi','hengi@x.com','x','Hengi','digitador','HENGI')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
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
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, path, who, body) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });
const hengiEdit = (extra) => ({ name: 'Hengi', username: 'hengi', role: 'digitador', in_payroll: true, ...extra });

test('normalizeBirthDate: accepts real past dates, empty clears, rejects the rest', () => {
  assert.deepEqual(normalizeBirthDate('1990-05-12'), { ok: true, value: '1990-05-12' });
  assert.deepEqual(normalizeBirthDate(''), { ok: true, value: null });
  assert.deepEqual(normalizeBirthDate(null), { ok: true, value: null });
  for (const bad of ['1990-02-30', '12/05/1990', '1899-12-31', '2999-01-01', 'abc', 19900512]) {
    assert.equal(normalizeBirthDate(bad).ok, false, String(bad));
  }
});

test('admin sets, keeps and clears a user birth date', async () => {
  let res = await call('PUT', `/api/admin/users/${ids.hengi}`, 'admin', hengiEdit({ birth_date: '1990-05-12' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.birth_date, '1990-05-12');

  const list = await (await call('GET', '/api/admin/users?status=all', 'admin')).json();
  assert.equal(list.users.find((u) => u.id === ids.hengi).birth_date, '1990-05-12');

  // Omitting the field (older dashboard) keeps it
  res = await call('PUT', `/api/admin/users/${ids.hengi}`, 'admin', hengiEdit());
  assert.equal((await res.json()).user.birth_date, '1990-05-12');

  const log = (await pool.query(`SELECT details FROM activity_log WHERE action = 'user.update' ORDER BY id ASC LIMIT 1`)).rows[0];
  assert.deepEqual(log.details.cambios.birth_date, { antes: null, despues: '1990-05-12' });

  res = await call('PUT', `/api/admin/users/${ids.hengi}`, 'admin', hengiEdit({ birth_date: '' }));
  assert.equal((await res.json()).user.birth_date, null);
});

test('admin: invalid birth date is rejected', async () => {
  const res = await call('PUT', `/api/admin/users/${ids.hengi}`, 'admin', hengiEdit({ birth_date: '2999-01-01' }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_BIRTH_DATE');
});

test('admin can set birth date on create', async () => {
  const res = await call('POST', '/api/admin/users', 'admin', { name: 'Pedro', username: 'pedro', role: 'digitador', temp_password: 'Temp2026x', birth_date: '1985-01-31' });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).user.birth_date, '1985-01-31');
});

test('a user sets their own birth date and /me returns it', async () => {
  let res = await call('PUT', '/api/auth/me/profile', 'hengi', { birthDate: '1992-11-03' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.birthDate, '1992-11-03');
  res = await call('GET', '/api/auth/me', 'hengi');
  assert.equal((await res.json()).user.birthDate, '1992-11-03');

  res = await call('PUT', '/api/auth/me/profile', 'hengi', { birthDate: 'nope' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_BIRTH_DATE');
});
