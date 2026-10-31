// Disculpa por demora (Jay, 2026-10-31): si el bot dejó al cliente 30 min sin respuesta, retoma con una disculpa
// y la respuesta real; si la IA sigue sin responder, una disculpa fija. Una vez, de 7 a. m. a 9 p. m., avisa al equipo.
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const recovery = require('../src/agent/recovery');
const { AI_DEFERRED } = require('../src/agent/agent');

const PHONE = '18095550001';
// sábado 31 de octubre de 2026, 12:40 p. m. en Santo Domingo
const NOW = new Date('2026-10-31T16:40:00Z');
const minAgo = (m) => new Date(NOW.getTime() - m * 60000);

let sent, turns, owns, available, reply;
recovery._setDeps({
  sender: {
    isAvailable: () => available,
    sendText: async (to, text) => { sent.push({ to, text }); return { key: { id: `wa-${sent.length}` } }; },
  },
  respond: async (phone, text, opts) => {
    turns.push({ phone, text, cutoff: opts.cutoff });
    if (!opts.shouldRun()) return '';
    if (reply === AI_DEFERRED) return AI_DEFERRED;
    await opts.deliver(reply);
    return reply;
  },
  botOwns: (phone) => owns.has(phone),
});

test.beforeEach(async () => {
  sent = []; turns = []; owns = new Set([PHONE]); available = true; reply = 'El poder sencillo sale en RD$1,000 🦉';
  delete process.env.BOT_DEMORA_MIN;
  await createAgentSchema();
  await pool.query('CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL');
  await createUser('leandro', 'admin', 'Leandro');
  await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Ana Cliente')`, [PHONE]);
});
test.after(() => pool.end());

const msg = (direction, content, at, { phone = PHONE, status = 'sent' } = {}) => pool.query(
  `INSERT INTO messages (phone, direction, content, wa_jid, created_at, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
  [phone, direction, content, `${phone}@s.whatsapp.net`, at, status]).then((r) => r.rows[0].id);
const avisos = async () => (await pool.query(`SELECT title FROM notifications ORDER BY id`)).rows.map((r) => r.title);

test('35 min sin respuesta: retoma con disculpa y la respuesta real, una sola vez, y avisa al equipo', async () => {
  await msg('outbound', '¿En qué le ayudo?', minAgo(60));
  await msg('inbound', 'cuánto cuesta un poder', minAgo(36));
  const last = await msg('inbound', 'sencillo', minAgo(35));
  assert.deepEqual(await recovery.processUnanswered(NOW), { sent: 1 });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'cuánto cuesta un poder\nsencillo');
  assert.equal(turns[0].cutoff, last);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, `${PHONE}@s.whatsapp.net`);
  assert.equal(sent[0].text, `${recovery.PREFIX}\n\n${reply}`);
  const out = (await pool.query(`SELECT content FROM messages WHERE direction = 'outbound' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(out.content, sent[0].text);
  assert.match((await avisos())[0], /^⏳ El bot tardó en responder: Ana Cliente/);
  // ya respondido: no se repite
  assert.deepEqual(await recovery.processUnanswered(new Date(NOW.getTime() + 600000)), { sent: 0 });
  assert.equal(sent.length, 1);
});

test('si la IA sigue sin cuota, manda la disculpa fija', async () => {
  reply = AI_DEFERRED;
  await msg('inbound', 'hola?', minAgo(40));
  assert.deepEqual(await recovery.processUnanswered(NOW), { sent: 1 });
  assert.deepEqual(sent.map((s) => s.text), [recovery.FIXED]);
});

test('no toca: menos de 30 min, chats ya respondidos, chats de una persona, mensajes viejos, el simulador ni más de 23 h', async () => {
  await msg('inbound', 'recién', minAgo(10));
  await msg('inbound', 'hola', minAgo(50), { phone: '18095550002' });
  await msg('outbound', 'respondido', minAgo(45), { phone: '18095550002' });
  await msg('inbound', 'con una persona', minAgo(50), { phone: '18095550003' });
  await msg('inbound', 'de hace días', minAgo(50), { phone: '18095550004', status: 'old' });
  await msg('inbound', 'prueba', minAgo(50), { phone: 'sim_abc' });
  await msg('inbound', 'ayer', minAgo(24 * 60), { phone: '18095550005' });
  owns = new Set([PHONE, '18095550002', '18095550004', 'sim_abc', '18095550005']); // 003: el chat lo tiene una persona
  assert.deepEqual(await recovery.processUnanswered(NOW), { sent: 0 });
  assert.equal(turns.length, 0);
});

test('fuera de 7 a. m. a 9 p. m. o sin conexión espera; BOT_DEMORA_MIN cambia los minutos', async () => {
  await msg('inbound', 'hola', minAgo(40));
  assert.deepEqual(await recovery.processUnanswered(new Date('2026-10-31T09:00:00Z')), { sent: 0, fueraDeHora: true }); // 5 a. m.
  available = false;
  assert.deepEqual(await recovery.processUnanswered(NOW), { sent: 0, sinConexion: true });
  available = true;
  process.env.BOT_DEMORA_MIN = '60';
  assert.deepEqual(await recovery.processUnanswered(NOW), { sent: 0 });
  process.env.BOT_DEMORA_MIN = '15';
  assert.deepEqual(await recovery.processUnanswered(NOW), { sent: 1 });
});
