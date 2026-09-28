const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {}, ids = {};

test.before(async () => {
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Leandro','admin'), ('hengi','hengi@x.com','x','Hengi','digitador'),
    ('marleni','marleni@x.com','x','Marleni','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query('DROP TABLE IF EXISTS avatar_settings');
  await runSqlFile('migrations/20260928_avatar_settings.sql');
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) {
    tok[u.username] = generateToken(u);
    ids[u.username] = u.id;
  }
  await pool.query(`UPDATE users SET avatar = NULL`);
  await pool.query(`UPDATE users SET avatar = 'cow' WHERE username = 'hengi'`);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../src/routes/auth'));
  app.use('/api/admin', require('../src/routes/admin'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, p, who, body) =>
  fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });
const avatarOf = async (u) => (await pool.query('SELECT avatar FROM users WHERE username = $1', [u])).rows[0].avatar;

test('a taken animal answers who has it', async () => {
  const res = await call('PUT', '/api/auth/me/appearance', 'admin', { avatar: 'cow' });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'AVATAR_TAKEN');
  assert.equal(body.owner, 'Hengi');
  assert.equal(await avatarOf('hengi'), 'cow');
});

test('the admin takes it after confirming; the employee loses it', async () => {
  const res = await call('PUT', '/api/auth/me/appearance', 'admin', { avatar: 'cow', force: true });
  assert.equal(res.status, 200);
  assert.equal(await avatarOf('admin'), 'cow');
  assert.equal(await avatarOf('hengi'), null);
  const log = (await pool.query(`SELECT summary FROM activity_log WHERE action = 'avatar.take' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.match(log.summary, /Hengi/);
});

test('employees cannot force-take an animal', async () => {
  const res = await call('PUT', '/api/auth/me/appearance', 'marleni', { avatar: 'cow', force: true });
  assert.equal(res.status, 409);
  assert.equal(await avatarOf('admin'), 'cow');
});

test("the admin changes an employee's animal (any animal, even disabled ones)", async () => {
  const res = await call('PUT', `/api/admin/users/${ids.marleni}/avatar`, 'admin', { avatar: 'sheep' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.avatar, 'sheep');
  assert.equal(await avatarOf('marleni'), 'sheep');
});

test("giving an employee someone else's animal needs confirmation and moves it", async () => {
  await call('PUT', `/api/admin/users/${ids.hengi}/avatar`, 'admin', { avatar: 'dog' });
  let res = await call('PUT', `/api/admin/users/${ids.marleni}/avatar`, 'admin', { avatar: 'dog' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).owner, 'Hengi');
  res = await call('PUT', `/api/admin/users/${ids.marleni}/avatar`, 'admin', { avatar: 'dog', force: true });
  assert.equal(res.status, 200);
  assert.equal(await avatarOf('marleni'), 'dog');
  assert.equal(await avatarOf('hengi'), null);
});

test('rules: owl only for admins, admin-only endpoint, valid keys, null clears', async () => {
  assert.equal((await call('PUT', `/api/admin/users/${ids.hengi}/avatar`, 'admin', { avatar: 'owl' })).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${ids.hengi}/avatar`, 'marleni', { avatar: 'cat' })).status, 403);
  assert.equal((await call('PUT', `/api/admin/users/${ids.hengi}/avatar`, 'admin', { avatar: 'dinosaurio' })).status, 400);
  assert.equal((await call('PUT', `/api/admin/users/99999/avatar`, 'admin', { avatar: 'cat' })).status, 404);
  const res = await call('PUT', `/api/admin/users/${ids.marleni}/avatar`, 'admin', { avatar: null });
  assert.equal(res.status, 200);
  assert.equal(await avatarOf('marleni'), null);
});
