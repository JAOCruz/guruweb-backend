// Cuando el cliente (o Leandro desde el teléfono) responde a un mensaje en WhatsApp, el chat del panel guarda a cuál
// y lo muestra como en WhatsApp: una miniatura del mensaje citado que lleva a él con un clic.
process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG-test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-respuesta-'));
const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const cloudHandler = require('../src/whatsapp/cloudHandler');
const Message = require('../src/models/Message');

const MIG = 'migrations/20261128_messages_reply_to.sql';
const PHONE = '18095550101';
const META = { phone_number_id: '111222333' };
let n = 0;
const old = () => String(Math.floor(Date.now() / 1000) - 3600); // viejo: el bot no contesta
const row = async (id) => (await pool.query('SELECT * FROM messages WHERE wa_message_id = $1', [id])).rows[0];
const send = async (m) => {
  const id = `wamid.RESP${++n}`;
  await cloudHandler.processWebhookPayload({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: META, contacts: [{ profile: { name: 'Ana' }, wa_id: PHONE }],
    messages: [{ from: PHONE, id, timestamp: old(), ...m }],
  } }] }] });
  return row(id);
};

test.before(async () => {
  await createAgentSchema();
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL');
  await pool.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS profile_pic_url TEXT');
  await runSqlFile(MIG);
  await runSqlFile(MIG); // idempotente
  await pool.query(`INSERT INTO messages (wa_message_id, phone, direction, content, media_url)
                    VALUES ('wamid.AUDIO', $1, 'inbound', '[📎 audio]', '/api/media/7/download')`, [PHONE]);
});
test.after(async () => { await pool.end(); });

test('el cliente responde a un audio: se guarda a cuál responde y el texto queda limpio', async () => {
  const r = await send({ type: 'text', text: { body: 'Eso es lo que necesito' }, context: { from: PHONE, id: 'wamid.AUDIO' } });
  assert.equal(r.reply_to_wa_message_id, 'wamid.AUDIO');
  assert.equal(r.content, 'Eso es lo que necesito');
});

test('Leandro responde desde el teléfono a un mensaje: también se guarda', async () => {
  const id = 'wamid.ECO1';
  await cloudHandler.processWebhookPayload({ entry: [{ changes: [{ field: 'smb_message_echoes', value: {
    metadata: META,
    message_echoes: [{ from: '18090000000', to: PHONE, id, timestamp: old(), type: 'text', text: { body: 'Sí, le escuché' }, context: { id: 'wamid.AUDIO' } }],
  } }] }] });
  const r = await row(id);
  assert.equal(r.reply_to_wa_message_id, 'wamid.AUDIO');
  assert.equal(r.content, 'Sí, le escuché');
});

test('el chat trae la miniatura del mensaje citado; si no está en el panel, lo dice', async () => {
  await send({ type: 'text', text: { body: 'Y esto?' }, context: { id: 'wamid.NOEXISTE' } });
  const msgs = await Message.findByPhone(PHONE);
  await Message.attachReplies(msgs);
  const audio = msgs.find((m) => m.wa_message_id === 'wamid.AUDIO');
  const resp = msgs.find((m) => m.content === 'Eso es lo que necesito');
  assert.deepEqual(resp.reply_to, { id: audio.id, direction: 'inbound', content: '[📎 audio]', media_url: '/api/media/7/download' });
  assert.deepEqual(msgs.find((m) => m.content === 'Y esto?').reply_to, { id: null });
  assert.equal(audio.reply_to, undefined);
});

test('si la migración no ha corrido, el mensaje se guarda igual', async () => {
  await pool.query('ALTER TABLE messages DROP COLUMN reply_to_wa_message_id');
  try {
    const r = await send({ type: 'text', text: { body: 'Sin columna' }, context: { id: 'wamid.AUDIO' } });
    assert.ok(r, 'se guardó');
    assert.match(r.content, /Sin columna/);
  } finally {
    await runSqlFile(MIG);
  }
});
