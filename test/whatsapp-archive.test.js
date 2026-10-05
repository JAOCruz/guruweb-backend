// "Empezar de cero" in Mensajes: old chats are archived (hidden from the list, never deleted).
process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {};

test.before(async () => {
  await resetDb();
  await pool.query('DROP TABLE IF EXISTS messages, clients, cases, wa_bot_state, activity_log CASCADE');
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, phone TEXT, name TEXT, assigned_to INT,
    profile_pic_url TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query('CREATE TABLE cases (id SERIAL PRIMARY KEY, user_id INT)');
  await pool.query(`CREATE TABLE messages (id SERIAL PRIMARY KEY, wa_message_id TEXT, phone TEXT, client_id INT, case_id INT,
    direction TEXT, content TEXT, media_url TEXT, push_name TEXT, wa_jid TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query('CREATE TABLE wa_bot_state (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Admin','admin'), ('hengi','hengi@x.com','x','Hengi','digitador')`);
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) tok[u.username] = generateToken(u);

  // old: a chat from August and a client registered then without messages
  await pool.query(`INSERT INTO clients (phone, name, created_at) VALUES ('18090000001','Viejo','2026-08-01'), ('18090000002','Sin mensajes','2026-08-01')`);
  await pool.query(`INSERT INTO messages (phone, client_id, direction, content, created_at) VALUES
    ('18090000001', 1, 'inbound', 'mensaje viejo', '2026-08-20'), ('18090000003', NULL, 'inbound', 'otro viejo', '2026-08-21')`);

  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', require('../src/routes/whatsapp'));
  app.use('/api/messages', require('../src/routes/messages'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, path, who) =>
  fetch(base + path, { method, headers: { Authorization: `Bearer ${tok[who]}` } });
const phones = async () => (await (await call('GET', '/api/messages/conversations', 'admin')).json())
  .conversations.map((c) => c.phone).sort();

test('before archiving, every chat shows', async () => {
  assert.deepEqual(await phones(), ['18090000001', '18090000002', '18090000003']);
});

test('only an admin can archive', async () => {
  assert.equal((await call('POST', '/api/whatsapp/archive-chats', 'hengi')).status, 403);
});

test('archiving hides the old chats, keeps every message, clears the manual marks and is logged', async () => {
  const handler = require('../src/whatsapp/handler');
  handler.setManualMode('18090000001', true);

  const res = await call('POST', '/api/whatsapp/archive-chats', 'admin');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.chatsSince);

  assert.deepEqual(await phones(), []);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM messages')).rows[0].n, 2);
  assert.equal(handler.isManualMode('18090000001'), false);

  const status = await (await call('GET', '/api/whatsapp/status', 'admin')).json();
  assert.equal(status.chatsSince, body.chatsSince);

  const { rows } = await pool.query(`SELECT action FROM activity_log`);
  assert.deepEqual(rows.map((r) => r.action), ['whatsapp.archive_chats']);
});

test('a new message (also from an old client) brings the chat back, with only what is new counted', async () => {
  await pool.query(`INSERT INTO messages (phone, client_id, direction, content) VALUES ('18090000001', 1, 'inbound', 'hola de nuevo')`);
  await pool.query(`INSERT INTO messages (phone, direction, content) VALUES ('18095550101', 'inbound', 'hola')`);
  const res = await (await call('GET', '/api/messages/conversations', 'admin')).json();
  const byPhone = Object.fromEntries(res.conversations.map((c) => [c.phone, c]));
  assert.deepEqual(Object.keys(byPhone).sort(), ['18090000001', '18095550101']);
  assert.equal(Number(byPhone['18090000001'].message_count), 1);
  assert.equal(byPhone['18090000001'].last_message, 'hola de nuevo');
});

test('a client registered after archiving shows even without messages', async () => {
  await pool.query(`INSERT INTO clients (phone, name) VALUES ('18090000009','Nuevo')`);
  assert.ok((await phones()).includes('18090000009'));
});

test('search still finds archived chats', async () => {
  const res = await (await call('GET', '/api/messages/search?q=viejo', 'admin')).json();
  assert.deepEqual(res.conversations.map((c) => c.phone).sort(), ['18090000001', '18090000003']);
});
