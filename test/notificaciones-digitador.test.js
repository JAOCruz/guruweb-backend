// Avisos al digitador: cuando el admin le anota un servicio, y cuando le pasan los chats y casos
// de un usuario desactivado. El clic lleva al servicio / a la lista que recibió.
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const { resetAssignmentTables } = require('./helpers/assignments');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {}, ids = {};

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/services', require('../src/routes/services'));
  app.use('/api/admin', require('../src/routes/admin'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await resetDb();
  await resetAssignmentTables();
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log, services, notifications CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query(`CREATE TABLE services (id SERIAL PRIMARY KEY, user_id INT, service_name TEXT, client TEXT, time TEXT,
    earnings NUMERIC, date DATE DEFAULT CURRENT_DATE, comment TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE notifications (id SERIAL PRIMARY KEY, user_id INT NOT NULL, type VARCHAR(50) NOT NULL, title VARCHAR(255) NOT NULL,
    message TEXT NOT NULL, link TEXT, read BOOLEAN DEFAULT false, read_at TIMESTAMPTZ, metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role, data_column) VALUES
    ('admin','admin@x.com','x','Leandro','admin',NULL), ('hengi','hengi@x.com','x','Hengi','digitador','HENGI'),
    ('marleni','marleni@x.com','x','Marleni','digitador','MARLENI')`);
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) {
    tok[u.username] = generateToken(u);
    ids[u.username] = u.id;
  }
});
test.after(async () => { server.close(); await pool.end(); });

const post = (path, who, body) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: JSON.stringify(body) });
const notifs = async (userId) =>
  (await pool.query('SELECT type, title, message, link, metadata FROM notifications WHERE user_id = $1 ORDER BY id', [userId])).rows;

test('anotarle un servicio al digitador le avisa con el servicio, el cliente y el monto', async () => {
  const res = await post('/api/services', 'admin', { username: 'hengi', serviceName: 'Poder notarial', client: 'Juan Pérez', earnings: 1500 });
  assert.equal(res.status, 201);
  const service = await res.json();
  const n = await notifs(ids.hengi);
  assert.equal(n.length, 1);
  assert.equal(n[0].type, 'service');
  assert.equal(n[0].title, '📝 Te anotaron un servicio');
  assert.equal(n[0].message, 'Poder notarial · cliente Juan Pérez · RD$ 1,500.00');
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santo_Domingo' }).format(new Date());
  assert.equal(n[0].link, `/?service=${service.id}&date=${today}`);
  assert.equal(n[0].metadata.service_id, service.id);
  assert.equal((await notifs(ids.admin)).length, 0); // quien lo anota no se avisa a sí mismo
});

test('sin cliente el aviso no lo menciona', async () => {
  await post('/api/services', 'admin', { username: 'hengi', serviceName: 'Copia', earnings: 200 });
  assert.equal((await notifs(ids.hengi))[0].message, 'Copia · RD$ 200.00');
});

test('un servicio con fecha abre ese día', async () => {
  const res = await post('/api/services', 'admin', { username: 'hengi', serviceName: 'Copia', earnings: 200, date: '2026-10-20' });
  assert.equal((await notifs(ids.hengi))[0].link, `/?service=${(await res.json()).id}&date=2026-10-20`);
});

test('si el servicio no se guarda, no hay aviso', async () => {
  assert.equal((await post('/api/services', 'admin', { username: 'nadie', serviceName: 'Copia', earnings: 200 })).status, 404);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n, 0);
});

test('al desactivar a alguien, quien recibe sus chats y casos se entera', async () => {
  await pool.query('INSERT INTO clients (phone, assigned_to) VALUES ($1,$3), ($2,$3)', ['1', '2', ids.marleni]);
  await pool.query('INSERT INTO cases (title, user_id) VALUES ($1,$2)', ['c1', ids.marleni]);
  assert.equal((await post(`/api/admin/users/${ids.marleni}/deactivate`, 'admin', { reassign_to: ids.hengi })).status, 200);
  const n = await notifs(ids.hengi);
  assert.equal(n.length, 1);
  assert.equal(n[0].type, 'assignment');
  assert.equal(n[0].title, '💬 Te pasaron los pendientes de Marleni');
  assert.equal(n[0].message, 'Ahora tienes 2 chats y 1 caso que eran de Marleni.');
  assert.equal(n[0].link, '/bot-messages');
});

test('solo casos: el aviso lleva a Casos; sin nada que pasar o sin receptor, no hay aviso', async () => {
  await pool.query('INSERT INTO cases (title, user_id) VALUES ($1,$2)', ['c1', ids.marleni]);
  await post(`/api/admin/users/${ids.marleni}/deactivate`, 'admin', { reassign_to: ids.hengi });
  const n = await notifs(ids.hengi);
  assert.equal(n[0].message, 'Ahora tienes 1 caso que era de Marleni.');
  assert.equal(n[0].link, '/cases');

  await pool.query('UPDATE users SET is_active = TRUE, deactivated_at = NULL');
  await pool.query('DELETE FROM notifications');
  await post(`/api/admin/users/${ids.hengi}/deactivate`, 'admin', { reassign_to: null });
  await post(`/api/admin/users/${ids.marleni}/deactivate`, 'admin', { reassign_to: ids.admin });
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM notifications')).rows[0].n, 0);
});
