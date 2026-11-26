// PIN de 4 dígitos para ver las ganancias del dashboard del admin (Jay, 2026-11-26).
// Se crea con la contraseña actual; se verifica con un límite de intentos. Solo el admin.
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const { generateToken } = require('../src/middleware/auth');

let server, base, tokens = {};

test.before(async () => {
  await resetDb();
  const hash = await bcrypt.hash('secret1', 4);
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role, data_column) VALUES
    ('admin','admin@x.com',$1,'Admin','admin',NULL),
    ('hengi','hengi@x.com',$1,'Hengi','digitador','HENGI')`, [hash]);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await runSqlFile('migrations/20260927_birth_date.sql');
  await runSqlFile('migrations/20261126_earnings_pin.sql');
  const { rows } = await pool.query('SELECT id, username, email, role FROM users');
  for (const u of rows) tokens[u.username] = generateToken(u);

  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/auth', require('../src/routes/auth'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => { server.close(); await pool.end(); });

const call = (method, path, who, body) =>
  fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });

const me = async (who) => (await (await call('GET', '/api/auth/me', who)).json()).user;

test('sin PIN, /me dice hasEarningsPin=false y verificar responde NO_PIN', async () => {
  assert.equal((await me('admin')).hasEarningsPin, false);
  const res = await call('POST', '/api/auth/me/earnings-pin/verify', 'admin', { pin: '1234' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'NO_PIN');
});

test('crear el PIN pide la contraseña actual correcta', async () => {
  const res = await call('PUT', '/api/auth/me/earnings-pin', 'admin', { currentPassword: 'mala', pin: '1234' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'WRONG_CURRENT_PASSWORD');
  assert.equal((await me('admin')).hasEarningsPin, false);
});

test('el PIN debe ser de 4 dígitos', async () => {
  for (const pin of ['123', '12345', 'abcd', '12 4', 1234]) {
    const res = await call('PUT', '/api/auth/me/earnings-pin', 'admin', { currentPassword: 'secret1', pin });
    assert.equal(res.status, 400, `pin ${pin}`);
    assert.equal((await res.json()).code, 'INVALID_PIN');
  }
});

test('el admin crea su PIN; se guarda cifrado y /me lo indica', async () => {
  const res = await call('PUT', '/api/auth/me/earnings-pin', 'admin', { currentPassword: 'secret1', pin: '4821' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).user.hasEarningsPin, true);
  const { rows } = await pool.query("SELECT earnings_pin_hash FROM users WHERE username='admin'");
  assert.notEqual(rows[0].earnings_pin_hash, '4821');
  assert.ok(await bcrypt.compare('4821', rows[0].earnings_pin_hash));
  assert.equal((await me('admin')).earnings_pin_hash, undefined);
});

test('un digitador no puede crear ni verificar un PIN', async () => {
  let res = await call('PUT', '/api/auth/me/earnings-pin', 'hengi', { currentPassword: 'secret1', pin: '1111' });
  assert.equal(res.status, 403);
  res = await call('POST', '/api/auth/me/earnings-pin/verify', 'hengi', { pin: '1111' });
  assert.equal(res.status, 403);
});

test('verificar: el PIN correcto abre, el equivocado no', async () => {
  let res = await call('POST', '/api/auth/me/earnings-pin/verify', 'admin', { pin: '4821' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  res = await call('POST', '/api/auth/me/earnings-pin/verify', 'admin', { pin: '0000' });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: 'PIN incorrecto', code: 'WRONG_PIN' });
});

test('tras 5 intentos equivocados hay que esperar (429), aunque luego ponga el correcto', async () => {
  // ya hubo 1 equivocado en la prueba anterior
  for (let i = 0; i < 4; i++) {
    const res = await call('POST', '/api/auth/me/earnings-pin/verify', 'admin', { pin: '9999' });
    assert.equal(res.status, 400);
  }
  const res = await call('POST', '/api/auth/me/earnings-pin/verify', 'admin', { pin: '4821' });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, 'TOO_MANY_ATTEMPTS');
});
