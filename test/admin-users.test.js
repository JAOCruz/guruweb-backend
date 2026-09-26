const { pool, runSqlFile, resetDb } = require('./helpers/db');
const { resetAssignmentTables } = require('./helpers/assignments');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {}, ids = {};

test.before(async () => {
  await resetDb();
  await resetAssignmentTables();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role, data_column) VALUES
    ('admin','admin@x.com','x','Admin','admin',NULL), ('boss2','boss2@x.com','x','Boss 2','admin',NULL),
    ('hengi','hengi@x.com','x','Hengi','digitador','HENGI'), ('marleni','marleni@x.com','x','Marleni','digitador','MARLENI')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) {
    tok[u.username] = generateToken(u);
    ids[u.username] = u.id;
  }
  await pool.query('INSERT INTO clients (phone, assigned_to) VALUES ($1,$2), ($3,$2)', ['1', ids.marleni, '2']);
  await pool.query('INSERT INTO cases (title, user_id) VALUES ($1,$2)', ['c1', ids.marleni]);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
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
const code = async (res) => (await res.json()).code;

test('non-admins are rejected', async () => {
  assert.equal((await call('GET', '/api/admin/users', 'hengi')).status, 403);
});

test('create user', async () => {
  const res = await call('POST', '/api/admin/users', 'admin', { name: 'Pedro Gómez', username: 'pedro', role: 'digitador', in_payroll: true, temp_password: 'temp123' });
  assert.equal(res.status, 201);
  const { user } = await res.json();
  assert.equal(user.must_change_password, true);
  assert.equal(user.data_column, 'PEDRO_GOMEZ');
  assert.equal(user.password_hash, undefined);
  ids.pedro = user.id;
  tok.pedro = generateToken({ id: user.id, username: 'pedro', email: null, role: 'digitador' });
});

test('create validations', async () => {
  let res = await call('POST', '/api/admin/users', 'admin', { name: 'Otro', username: 'PEDRO', role: 'digitador', in_payroll: false, temp_password: 'temp123' });
  assert.equal(res.status, 409); assert.equal(await code(res), 'USERNAME_TAKEN');
  res = await call('POST', '/api/admin/users', 'admin', { name: 'X', username: 'x1', role: 'superuser', in_payroll: false, temp_password: 'temp123' });
  assert.equal(res.status, 400); assert.equal(await code(res), 'INVALID_ROLE');
  res = await call('POST', '/api/admin/users', 'admin', { name: 'X', username: 'x2', role: 'digitador', in_payroll: false, temp_password: '123' });
  assert.equal(res.status, 400); assert.equal(await code(res), 'PASSWORD_TOO_SHORT');
  res = await call('POST', '/api/admin/users', 'admin', { name: '', username: '', role: 'digitador', in_payroll: false, temp_password: 'temp123' });
  assert.equal(res.status, 400); assert.equal(await code(res), 'NAME_REQUIRED');
});

test('exact duplicate username (production constraint) → 409 USERNAME_TAKEN', async () => {
  const res = await call('POST', '/api/admin/users', 'admin', { name: 'Otro', username: 'pedro', role: 'digitador', in_payroll: false, temp_password: 'temp123' });
  assert.equal(res.status, 409);
  assert.equal(await code(res), 'USERNAME_TAKEN');
});

test('duplicate email → 409 EMAIL_TAKEN', async () => {
  const res = await call('POST', '/api/admin/users', 'admin', { name: 'Otro', username: 'otro', email: 'hengi@x.com', role: 'digitador', in_payroll: false, temp_password: 'temp123' });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'Ese email ya está en uso', code: 'EMAIL_TAKEN' });
});

test('new user is gated until they change the password', async () => {
  const res = await call('GET', '/api/admin/users', 'pedro');
  assert.equal(res.status, 403);
  assert.equal(await code(res), 'PASSWORD_CHANGE_REQUIRED');
});

test('update user and self-demotion guard', async () => {
  let res = await call('PUT', `/api/admin/users/${ids.hengi}`, 'admin', { name: 'Hengi R', username: 'hengi', email: '', role: 'digitador', in_payroll: true });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.name, 'Hengi R');
  res = await call('PUT', `/api/admin/users/${ids.admin}`, 'admin', { name: 'Admin', username: 'admin', role: 'digitador', in_payroll: false });
  assert.equal(res.status, 400); assert.equal(await code(res), 'CANNOT_DEMOTE_SELF');
});

test('temp password invalidates the status cache immediately', async () => {
  assert.equal((await call('GET', '/api/admin/users', 'boss2')).status, 200); // warm cache
  const res = await call('POST', `/api/admin/users/${ids.boss2}/temp-password`, 'admin', { temp_password: 'nueva123' });
  assert.equal(res.status, 200);
  const after = await call('GET', '/api/admin/users', 'boss2');
  assert.equal(after.status, 403);
  assert.equal(await code(after), 'PASSWORD_CHANGE_REQUIRED');
  await pool.query('UPDATE users SET must_change_password = FALSE WHERE id = $1', [ids.boss2]);
  require('../src/middleware/auth').invalidateUserStatus(ids.boss2);
});

test('assignments counts', async () => {
  const res = await call('GET', `/api/admin/users/${ids.marleni}/assignments`, 'admin');
  assert.deepEqual(await res.json(), { clients: 2, cases: 1 });
});

test('deactivate guards', async () => {
  let res = await call('POST', `/api/admin/users/${ids.admin}/deactivate`, 'admin', { reassign_to: null });
  assert.equal(res.status, 400); assert.equal(await code(res), 'CANNOT_DEACTIVATE_SELF');
  res = await call('POST', `/api/admin/users/${ids.marleni}/deactivate`, 'admin', { reassign_to: ids.marleni });
  assert.equal(res.status, 400); assert.equal(await code(res), 'INVALID_REASSIGN');
  res = await call('POST', '/api/admin/users/99999/deactivate', 'admin', { reassign_to: null });
  assert.equal(res.status, 404); assert.equal(await code(res), 'USER_NOT_FOUND');
});

test('deactivate marleni: reassigned and locked out immediately', async () => {
  assert.equal((await call('GET', '/api/admin/users', 'marleni')).status, 403); // warm cache (not admin)
  const res = await call('POST', `/api/admin/users/${ids.marleni}/deactivate`, 'admin', { reassign_to: ids.hengi });
  assert.equal(res.status, 200);
  const after = await call('GET', '/api/admin/users', 'marleni');
  assert.equal(after.status, 401);
  assert.equal(await code(after), 'USER_INACTIVE');
  const counts = await (await call('GET', `/api/admin/users/${ids.hengi}/assignments`, 'admin')).json();
  assert.deepEqual(counts, { clients: 2, cases: 1 });
});

test('status filter', async () => {
  const { users } = await (await call('GET', '/api/admin/users?status=inactive', 'admin')).json();
  assert.deepEqual(users.map((u) => u.username), ['marleni']);
});

test('demoted admin loses admin access immediately (role read from DB, not the token)', async () => {
  const res = await call('PUT', `/api/admin/users/${ids.boss2}`, 'admin', { name: 'Boss 2', username: 'boss2', role: 'digitador', in_payroll: false });
  assert.equal(res.status, 200);
  assert.equal((await call('GET', '/api/admin/users', 'boss2')).status, 403); // token still says admin
});

test('reactivate gives access back and a color', async () => {
  const res = await call('POST', `/api/admin/users/${ids.marleni}/reactivate`, 'admin');
  assert.equal(res.status, 200);
  const { user } = await res.json();
  assert.equal(user.is_active, true);
  assert.ok(user.color);
});

test('default list (used by assignment dropdowns) hides deactivated users and fills empty names', async () => {
  await pool.query(`UPDATE users SET name = '' WHERE username = 'hengi'`);
  await call('POST', `/api/admin/users/${ids.marleni}/deactivate`, 'admin', { reassign_to: null });
  const { users } = await (await call('GET', '/api/admin/users', 'admin')).json();
  assert.ok(!users.some((u) => u.username === 'marleni'));
  assert.equal(users.find((u) => u.username === 'hengi').name, 'HENGI');
});

test('digitadores dropdown excludes deactivated users', async () => {
  const res = await call('GET', '/api/admin/digitadores', 'admin');
  const body = await res.json();
  const list = body.users || body.digitadores || body;
  assert.ok(!list.some((u) => u.username === 'marleni' || u.id === ids.marleni));
});
