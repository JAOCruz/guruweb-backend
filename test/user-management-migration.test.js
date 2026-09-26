const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

const MIG = 'migrations/20260926_user_management.sql';

test.beforeEach(async () => {
  await resetDb();
  await pool.query(`INSERT INTO users (username, password_hash, name, role, data_column) VALUES
    ('admin','x','Admin','admin',NULL), ('hengi','x','Hengi','digitador','Hengi'),
    ('aux1','x','Aux I','auxiliar','AUXILIAR_I'), ('administracion','x','Administracion','digitador',NULL)`);
});
test.after(async () => { await pool.end(); });

test('adds status columns with safe defaults', async () => {
  await runSqlFile(MIG);
  const { rows } = await pool.query('SELECT username, is_active, must_change_password, deactivated_at FROM users ORDER BY id');
  assert.ok(rows.every((r) => r.is_active === true && r.must_change_password === false && r.deactivated_at === null));
});

test('in_payroll seeded only for the six current payroll columns', async () => {
  await runSqlFile(MIG);
  const { rows } = await pool.query('SELECT username FROM users WHERE in_payroll ORDER BY id');
  assert.deepEqual(rows.map((r) => r.username), ['hengi', 'aux1']);
});

test('idempotent', async () => {
  await runSqlFile(MIG);
  await runSqlFile(MIG);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM users WHERE in_payroll');
  assert.equal(rows[0].n, 2);
});

test('username unique ignoring case', async () => {
  await runSqlFile(MIG);
  await assert.rejects(
    pool.query(`INSERT INTO users (username, password_hash, role) VALUES ('HENGI','x','digitador')`),
    { code: '23505', constraint: 'users_username_lower_unique' }
  );
});
