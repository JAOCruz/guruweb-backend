const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

test.after(async () => { await pool.end(); });

test('users with a removed animal go back to no avatar; others keep theirs', async () => {
  await resetDb();
  await pool.query(`INSERT INTO users (username, password_hash, role) VALUES ('a','x','admin'), ('b','x','digitador'), ('c','x','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await pool.query(`UPDATE users SET avatar = 'turtle' WHERE username = 'b'`);
  await pool.query(`UPDATE users SET avatar = 'cow' WHERE username = 'c'`);
  await runSqlFile('migrations/20260927_animal_faces.sql');
  const rows = Object.fromEntries((await pool.query('SELECT username, avatar FROM users')).rows.map((r) => [r.username, r.avatar]));
  assert.deepEqual(rows, { a: 'owl', b: null, c: 'cow' });
});
