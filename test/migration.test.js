const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

const MIGRATION = 'migrations/20260926_user_appearance.sql';

async function seedUsers() {
  await pool.query(`
    INSERT INTO users (username, password_hash, name, role, data_column) VALUES
      ('admin',   'x', 'Admin',   'admin',     NULL),
      ('hengi',   'x', 'Hengi',   'digitador', 'HENGI'),
      ('marleni', 'x', 'Marleni', 'digitador', 'marleni'),
      ('israel',  'x', 'Israel',  'digitador', 'ISRAEL'),
      ('thaicar', 'x', 'Thaicar', 'digitador', 'THAICAR'),
      ('aux1',    'x', 'Aux I',   'auxiliar',  'AUXILIAR_I'),
      ('aux2',    'x', 'Aux II',  'auxiliar',  'AUXILIAR_II'),
      ('admin2',  'x', 'Admin 2', 'admin',     NULL)`);
}

test.beforeEach(async () => { await resetDb(); await seedUsers(); });
test.after(async () => { await pool.end(); });

test('seeds current colors by data_column (case-insensitive) and first free for the rest', async () => {
  await runSqlFile(MIGRATION);
  const { rows } = await pool.query('SELECT username, color FROM users ORDER BY id');
  const byName = Object.fromEntries(rows.map((r) => [r.username, r.color]));
  assert.equal(byName.hengi, 'green');
  assert.equal(byName.marleni, 'yellow');
  assert.equal(byName.israel, 'red');
  assert.equal(byName.thaicar, 'purple');
  assert.equal(byName.aux1, 'orange');
  assert.equal(byName.aux2, 'pink');
  assert.equal(byName.admin, 'teal');   // first free, lowest id
  assert.equal(byName.admin2, 'cyan');  // next free
});

test('owl goes to the lowest-id admin only; others have no avatar', async () => {
  await runSqlFile(MIGRATION);
  const { rows } = await pool.query('SELECT username, avatar FROM users WHERE avatar IS NOT NULL');
  assert.deepEqual(rows, [{ username: 'admin', avatar: 'owl' }]);
});

test('is idempotent (runs twice without error or changes)', async () => {
  await runSqlFile(MIGRATION);
  const before = (await pool.query('SELECT id, color, avatar FROM users ORDER BY id')).rows;
  await runSqlFile(MIGRATION);
  const after = (await pool.query('SELECT id, color, avatar FROM users ORDER BY id')).rows;
  assert.deepEqual(after, before);
});

test('unique indexes reject duplicate color and avatar', async () => {
  await runSqlFile(MIGRATION);
  await assert.rejects(pool.query(`UPDATE users SET color = 'green' WHERE username = 'israel'`), { code: '23505', constraint: 'users_color_unique' });
  await assert.rejects(pool.query(`UPDATE users SET avatar = 'owl' WHERE username = 'hengi'`), { code: '23505', constraint: 'users_avatar_unique' });
});
