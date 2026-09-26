const { pool, runSqlFile, resetDb } = require('./helpers/db');
const { resetAssignmentTables } = require('./helpers/assignments');
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const User = require('../src/models/User');

let ids;

test.beforeEach(async () => {
  await resetDb();
  await resetAssignmentTables();
  await pool.query(`INSERT INTO users (username, password_hash, name, role, data_column) VALUES
    ('admin','x','Admin','admin',NULL), ('hengi','x','Hengi','digitador','HENGI'), ('marleni','x','Marleni','digitador','MARLENI')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  const rows = (await pool.query('SELECT id, username FROM users')).rows;
  ids = Object.fromEntries(rows.map((r) => [r.username, r.id]));
  await pool.query('INSERT INTO clients (phone, assigned_to) VALUES ($1,$2), ($3,$2)', ['1', ids.marleni, '2']);
  await pool.query('INSERT INTO cases (title, user_id) VALUES ($1,$2)', ['c1', ids.marleni]);
});
test.after(async () => { await pool.end(); });

test('slugDataColumn strips accents and spaces', () => {
  assert.equal(User.slugDataColumn('José Peña'), 'JOSE_PENA');
  assert.equal(User.slugDataColumn('  Ana  María '), 'ANA_MARIA');
});

test('adminCreate sets temp password flag, color and payroll column', async () => {
  const u = await User.adminCreate({ name: 'José Peña', username: 'jose', role: 'digitador', in_payroll: true, temp_password: 'temp123' });
  assert.equal(u.data_column, 'JOSE_PENA');
  assert.equal(u.must_change_password, true);
  assert.equal(u.in_payroll, true);
  assert.ok(u.color);
  assert.ok(await bcrypt.compare('temp123', u.password_hash));
});

test('payroll column is made unique', async () => {
  await User.adminCreate({ name: 'José Peña', username: 'jose', role: 'digitador', in_payroll: true, temp_password: 'temp123' });
  const u = await User.adminCreate({ name: 'Jose Pena', username: 'jose2', role: 'digitador', in_payroll: true, temp_password: 'temp123' });
  assert.equal(u.data_column, 'JOSE_PENA_2');
});

test('no payroll column when not in payroll', async () => {
  const u = await User.adminCreate({ name: 'Recepción', username: 'recep', role: 'admin', in_payroll: false, temp_password: 'temp123' });
  assert.equal(u.data_column, null);
});

test('duplicate username ignoring case rejects', async () => {
  await assert.rejects(User.adminCreate({ name: 'X', username: 'HENGI', role: 'digitador', in_payroll: false, temp_password: 'temp123' }), { code: '23505' });
});

test('adminUpdate edits fields and adds payroll column when enabled', async () => {
  const u = await User.adminUpdate(ids.admin, { name: 'Jefe', username: 'admin', email: 'a@x.com', role: 'admin', in_payroll: true });
  assert.equal(u.name, 'Jefe');
  assert.equal(u.data_column, 'JEFE');
});

test('setTempPassword forces a change', async () => {
  const u = await User.setTempPassword(ids.hengi, 'otra123');
  assert.equal(u.must_change_password, true);
  assert.ok(await bcrypt.compare('otra123', u.password_hash));
});

test('countAssignments', async () => {
  assert.deepEqual(await User.countAssignments(ids.marleni), { clients: 2, cases: 1 });
});

test('deactivate reassigns and frees appearance', async () => {
  const u = await User.deactivate(ids.marleni, ids.hengi);
  assert.equal(u.is_active, false);
  assert.ok(u.deactivated_at);
  assert.equal(u.color, null);
  assert.equal(u.avatar, null);
  assert.deepEqual(await User.countAssignments(ids.hengi), { clients: 2, cases: 1 });
});

test('deactivate with null leaves them unassigned', async () => {
  await User.deactivate(ids.marleni, null);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM clients WHERE assigned_to IS NULL');
  assert.equal(rows[0].n, 2);
});

test('invalid reassign rolls back everything', async () => {
  await assert.rejects(User.deactivate(ids.marleni, 99999), { code: 'INVALID_REASSIGN' });
  const m = await User.findById(ids.marleni);
  assert.equal(m.is_active, true);
  assert.deepEqual(await User.countAssignments(ids.marleni), { clients: 2, cases: 1 });
});

test('reactivate restores access and a color', async () => {
  await User.deactivate(ids.marleni, null);
  const u = await User.reactivate(ids.marleni);
  assert.equal(u.is_active, true);
  assert.equal(u.deactivated_at, null);
  assert.ok(u.color);
});

test('countActiveAdmins', async () => {
  assert.equal(await User.countActiveAdmins(), 1);
  assert.equal(await User.countActiveAdmins(ids.admin), 0);
});

test('adminList filters by status', async () => {
  await User.deactivate(ids.marleni, null);
  assert.deepEqual((await User.adminList('inactive')).map((u) => u.username), ['marleni']);
  assert.equal((await User.adminList('active')).length, 2);
  assert.equal((await User.adminList('all')).length, 3);
  assert.equal((await User.adminList('all'))[0].password_hash, undefined);
});
