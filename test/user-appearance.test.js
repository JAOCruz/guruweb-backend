const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const User = require('../src/models/User');

test.beforeEach(async () => {
  await resetDb();
  await pool.query(`INSERT INTO users (username, password_hash, name, role, data_column) VALUES
    ('admin','x','Admin','admin',NULL), ('hengi','x','Hengi','digitador','HENGI'), ('israel','x','Israel','digitador','ISRAEL')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
});
test.after(async () => { await pool.end(); });

test('updateAppearance changes color and avatar', async () => {
  const hengi = await User.findByUsername('hengi');
  const row = await User.updateAppearance(hengi.id, { color: 'blue', avatar: 'cow' });
  assert.equal(row.color, 'blue');
  assert.equal(row.avatar, 'cow');
});

test('updateAppearance only touches provided fields; avatar null clears', async () => {
  const hengi = await User.findByUsername('hengi');
  await User.updateAppearance(hengi.id, { avatar: 'cat' });
  const row = await User.updateAppearance(hengi.id, { avatar: null });
  assert.equal(row.avatar, null);
  assert.equal(row.color, 'green');
});

test('taken color throws unique violation', async () => {
  const hengi = await User.findByUsername('hengi');
  await assert.rejects(User.updateAppearance(hengi.id, { color: 'red' }), { code: '23505', constraint: 'users_color_unique' });
});

test('re-saving own color is fine', async () => {
  const hengi = await User.findByUsername('hengi');
  const row = await User.updateAppearance(hengi.id, { color: 'green' });
  assert.equal(row.color, 'green');
});

test('listDirectory exposes public fields only', async () => {
  const users = await User.listDirectory();
  assert.equal(users.length, 3);
  assert.deepEqual(Object.keys(users[0]).sort(), ['avatar', 'color', 'data_column', 'id', 'name', 'role', 'username']);
});

test('create auto-assigns first free color', async () => {
  const u = await User.create({ email: 'n@x.com', password: 'secret1', name: 'Nuevo', username: 'nuevo' });
  assert.equal(u.color, 'purple'); // hengi=green, israel=red, admin=yellow (first free) → purple is next
});

test('toPublicUser shape', () => {
  const pub = User.toPublicUser({ id: 1, username: 'h', email: null, name: null, role: 'digitador', data_column: 'HENGI', color: 'green', avatar: null, password_hash: 'x' });
  assert.deepEqual(pub, { id: 1, username: 'h', email: 'h', name: 'h', role: 'digitador', dataColumn: 'HENGI', color: 'green', avatar: null });
});
