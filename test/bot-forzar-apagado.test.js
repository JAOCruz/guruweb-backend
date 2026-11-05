// BOT_FORZAR_APAGADO: seguro de Railway para tener el número real en modo manual. El bot no le escribe a
// ningún cliente aunque la base diga que está encendido o no se pueda leer, y lo guardado no cambia.
process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
const { pool } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

const PHONE = '18095550101';
const settle = () => new Promise((r) => setTimeout(r, 100));
const saved = async () => (await pool.query(`SELECT value FROM wa_bot_state WHERE key = 'bot_settings'`)).rows[0].value;
let handler;

test.before(async () => {
  await pool.query('DROP TABLE IF EXISTS wa_bot_state');
  await pool.query('CREATE TABLE wa_bot_state (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)');
  await pool.query(`INSERT INTO wa_bot_state VALUES ('bot_settings', $1, NOW())`,
    [JSON.stringify({ botActive: true, botMode: 'all', enabledPhones: [], manualPhones: [] })]);
  handler = require('../src/whatsapp/handler');
  await settle();
});
test.afterEach(() => { delete process.env.BOT_FORZAR_APAGADO; });
test.after(async () => { await pool.end(); });

test('sin la variable, el bot encendido contesta', () => {
  assert.equal(handler.isBotActive(), true);
  assert.equal(handler.shouldBotRespond(PHONE), true);
  assert.equal(handler.chatBotOn(PHONE), true);
});

test('con la variable no contesta, aunque la base diga encendido, y los chats salen en manual', () => {
  process.env.BOT_FORZAR_APAGADO = 'true';
  assert.equal(handler.isBotActive(), false);
  assert.equal(handler.shouldBotRespond(PHONE), false);
  assert.equal(handler.chatBotOn(PHONE), false);
});

test('los botones no lo encienden ni cambian lo guardado', async () => {
  process.env.BOT_FORZAR_APAGADO = 'true';
  handler.setBotActive(false);
  assert.equal(handler.toggleChatBot(PHONE), false);
  handler.setBotActive(true);
  await settle();
  assert.equal(handler.shouldBotRespond(PHONE), false);
  assert.deepEqual((await saved()).manualPhones, []);
  assert.equal((await saved()).botActive, true);
});

test('un valor mal escrito también lo apaga; solo false, 0, no o vacío lo dejan como estaba', () => {
  const { botForzadoApagado } = require('../src/whatsapp/forzarApagado');
  for (const v of ['true', 'TRUE', '1', 'si', 'sí', 'ture']) {
    process.env.BOT_FORZAR_APAGADO = v;
    assert.equal(botForzadoApagado(), true, v);
  }
  for (const v of ['', '  ', 'false', 'FALSE', '0', 'no']) {
    process.env.BOT_FORZAR_APAGADO = v;
    assert.equal(botForzadoApagado(), false, JSON.stringify(v));
  }
});

test('el panel ve el bot apagado: estado e interruptor dicen la verdad', async () => {
  process.env.BOT_FORZAR_APAGADO = 'true';
  const express = require('express');
  const jwt = require('jsonwebtoken');
  await pool.query('DROP TABLE IF EXISTS users CASCADE');
  await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, username TEXT, role TEXT, status TEXT DEFAULT 'active',
    active BOOLEAN DEFAULT TRUE, must_change_password BOOLEAN DEFAULT FALSE, last_seen TIMESTAMPTZ)`);
  const { rows } = await pool.query(`INSERT INTO users (username, role) VALUES ('qa_admin', 'admin') RETURNING id`);
  const token = jwt.sign({ id: rows[0].id, username: 'qa_admin', role: 'admin' }, process.env.JWT_SECRET);
  const app = express();
  app.use(express.json());
  app.use('/api/whatsapp', require('../src/routes/whatsapp'));
  const server = await new Promise((r) => { const sv = app.listen(0, () => r(sv)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/whatsapp`;
    const headers = { Authorization: `Bearer ${token}` };
    const toggle = await fetch(`${base}/bot-toggle`, { method: 'POST', headers });
    assert.equal(toggle.status, 200);
    assert.equal((await toggle.json()).botActive, false);
    const status = await fetch(`${base}/status`, { headers });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).botActive, false);
  } finally {
    server.close();
  }
  assert.equal((await saved()).botActive, true);
});

test('si no se puede leer la configuración, la variable igual lo mantiene apagado', async () => {
  process.env.BOT_FORZAR_APAGADO = 'true';
  await pool.query('ALTER TABLE wa_bot_state RENAME TO wa_bot_state_x');
  delete require.cache[require.resolve('../src/whatsapp/handler')];
  const fresh = require('../src/whatsapp/handler');
  await settle();
  await pool.query('ALTER TABLE wa_bot_state_x RENAME TO wa_bot_state');
  assert.equal(fresh.shouldBotRespond(PHONE), false);
});
