// Con la conexión de Meta, un ID oculto viejo de Baileys (@lid) no sirve: se envía al número del cliente.
process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG-test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pool } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const Message = require('../src/models/Message');

const PHONE = '18095550188';
const ins = (jid, ago) => pool.query(
  `INSERT INTO messages (phone, direction, content, wa_jid, created_at) VALUES ($1, 'inbound', 'x', $2, NOW() - INTERVAL '${ago}')`, [PHONE, jid]);

test.before(async () => { await createAgentSchema(); });
test.after(async () => { await pool.end(); });

test('si el único mensaje del cliente vino de un ID oculto viejo, no se usa ese destino', async () => {
  await ins('276209380372647@lid', '90 days');
  assert.equal(await Message.getLastJid(PHONE), null);
});

test('si hay uno normal, se usa aunque el @lid sea más nuevo', async () => {
  await ins(`${PHONE}@s.whatsapp.net`, '100 days');
  await ins('276209380372647@lid', '1 day');
  assert.equal(await Message.getLastJid(PHONE), `${PHONE}@s.whatsapp.net`);
});
