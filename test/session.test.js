const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const DAY = 24 * 60 * 60;
let server, base, hengi;

const sign = (payload, iatOffsetDays, lifetimeDays) => {
  const iat = Math.floor(Date.now() / 1000) - iatOffsetDays * DAY;
  return jwt.sign({ ...payload, iat, exp: iat + lifetimeDays * DAY }, 'test-secret', { algorithm: 'HS256' });
};

test.before(async () => {
  await resetDb();
  const hash = await bcrypt.hash('secret1', 4);
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role, data_column)
                    VALUES ('hengi','hengi@x.com',$1,'Hengi','digitador','HENGI')`, [hash]);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  hengi = (await pool.query(`SELECT id, username, email, role FROM users WHERE username = 'hengi'`)).rows[0];

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../src/routes/auth'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { server.close(); await pool.end(); });

const me = (token) => fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });

test('login token records the recuérdame choice', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'hengi', password: 'secret1', rememberMe: true }),
  });
  const { token } = await res.json();
  const p = jwt.decode(token);
  assert.equal(p.rm, true);
  assert.equal(p.exp - p.iat, 30 * DAY);
});

test('fresh token is not renewed', async () => {
  const res = await me(sign({ ...hengi, rm: true }, 0, 30));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).token, undefined);
});

test('remembered token older than a day is renewed for another 30 days', async () => {
  const res = await me(sign({ ...hengi, rm: true }, 2, 30));
  const body = await res.json();
  assert.ok(body.token);
  const p = jwt.decode(body.token);
  assert.equal(p.rm, true);
  assert.equal(p.exp - p.iat, 30 * DAY);
  assert.ok(Date.now() / 1000 - p.iat < 60);
  assert.match(res.headers.get('set-cookie') || '', /access_token=/);
});

test('non-remembered token is renewed with the short lifetime', async () => {
  const body = await (await me(sign({ ...hengi, rm: false }, 2, 7))).json();
  const p = jwt.decode(body.token);
  assert.equal(p.rm, false);
  assert.equal(p.exp - p.iat, 7 * DAY);
});

test('legacy 30-day token without rm claim is treated as remembered', async () => {
  const body = await (await me(sign(hengi, 2, 30))).json();
  const p = jwt.decode(body.token);
  assert.equal(p.rm, true);
  assert.equal(p.exp - p.iat, 30 * DAY);
});
