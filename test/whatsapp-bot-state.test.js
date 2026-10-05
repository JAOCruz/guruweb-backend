// Bot on/off per chat: "Seleccionados" (testing with chosen chats) must stay that way.
process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
const { pool } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

const settle = () => new Promise((r) => setTimeout(r, 100));
let handler;

test.before(async () => {
  await pool.query('DROP TABLE IF EXISTS wa_bot_state');
  await pool.query('CREATE TABLE wa_bot_state (key TEXT PRIMARY KEY, value JSONB, updated_at TIMESTAMPTZ)');
  // persisted: "selected" with nobody enabled yet (Leandro hasn't picked a chat)
  await pool.query(`INSERT INTO wa_bot_state VALUES ('bot_settings', $1, NOW())`,
    [JSON.stringify({ botActive: true, botMode: 'selected', enabledPhones: [], manualPhones: [] })]);
  handler = require('../src/whatsapp/handler');
  await settle();
});
test.after(async () => { await pool.end(); });

test('a restart keeps "selected" even with no chat enabled (never back to everyone)', () => {
  assert.equal(handler.getBotMode(), 'selected');
  assert.equal(handler.shouldBotRespond('18095550101'), false);
});

test('in "selected" the chat button turns the bot on and off for that chat only', () => {
  assert.equal(handler.chatBotOn('18095550101'), false);
  assert.equal(handler.toggleChatBot('18095550101'), true);
  assert.equal(handler.shouldBotRespond('18095550101'), true);
  assert.equal(handler.shouldBotRespond('18095550202'), false);
  assert.equal(handler.toggleChatBot('18095550101'), false);
  assert.equal(handler.shouldBotRespond('18095550101'), false);
});

test('enabling a chat that was taken over by an agent hands it back to the bot', () => {
  handler.setManualMode('18095550303', true);
  assert.equal(handler.toggleChatBot('18095550303'), true);
  assert.equal(handler.isManualMode('18095550303'), false);
  assert.equal(handler.shouldBotRespond('18095550303'), true);
});

test('in "all" the button is the agent takeover, as before', () => {
  handler.setBotMode('all');
  assert.equal(handler.chatBotOn('18095550404'), true);
  assert.equal(handler.toggleChatBot('18095550404'), false);
  assert.equal(handler.isManualMode('18095550404'), true);
  assert.equal(handler.toggleChatBot('18095550404'), true);
  assert.equal(handler.isManualMode('18095550404'), false);
});

test('pausing the whole bot does not change what each chat shows', () => {
  handler.setBotActive(false);
  assert.equal(handler.chatBotOn('18095550505'), true);
  assert.equal(handler.shouldBotRespond('18095550505'), false);
  handler.setBotActive(true);
});

test('the state is saved, so a restart keeps the enabled chats', async () => {
  handler.setBotMode('selected');
  handler.toggleChatBot('18095550606');
  await settle();
  const { rows } = await pool.query(`SELECT value FROM wa_bot_state WHERE key = 'bot_settings'`);
  assert.equal(rows[0].value.botMode, 'selected');
  assert.deepEqual(rows[0].value.enabledPhones, ['18095550606']);
});
