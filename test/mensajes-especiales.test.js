// Stickers, reacciones, contactos y lo que Meta no deja ver (unsupported): cómo quedan en el chat del panel.
process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG-test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-especiales-'));
const test = require('node:test');
const assert = require('node:assert/strict');

const { pool } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const cloudHandler = require('../src/whatsapp/cloudHandler');

const PHONE = '18095550101';
const META = { phone_number_id: '111222333' };
let n = 0;
const send = async (m) => {
  const id = `wamid.ESP${++n}`;
  await cloudHandler.processWebhookPayload({ entry: [{ changes: [{ field: 'messages', value: {
    metadata: META, contacts: [{ profile: { name: 'Ana' }, wa_id: PHONE }],
    messages: [{ from: PHONE, id, timestamp: String(Math.floor(Date.now() / 1000) - 3600), ...m }],
  } }] }] });
  const { rows } = await pool.query('SELECT content, media_url FROM messages WHERE wa_message_id = $1', [id]);
  return rows[0];
};

test.before(async () => {
  await createAgentSchema();
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL');
  await pool.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS profile_pic_url TEXT');
  await pool.query('ALTER TABLE client_media ADD COLUMN IF NOT EXISTS original_name TEXT, ADD COLUMN IF NOT EXISTS saved_name TEXT, ADD COLUMN IF NOT EXISTS file_size INT, ADD COLUMN IF NOT EXISTS context TEXT, ADD COLUMN IF NOT EXISTS doc_request_id INT');
});
test.after(async () => { await pool.end(); });

test('un sticker se guarda y se ve como imagen en el chat', async () => {
  const original = global.fetch;
  global.fetch = async (url) => (String(url).includes('lookaside')
    ? new Response(Buffer.from('RIFFxxxxWEBP'), { status: 200 })
    : new Response(JSON.stringify({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'image/webp' }), { status: 200 }));
  try {
    const row = await send({ type: 'sticker', sticker: { id: 'st1', mime_type: 'image/webp', animated: false } });
    assert.match(row.media_url, /^\/api\/media\/\d+\/download$/);
    assert.equal(row.content, '[📎 sticker]');
    const { rows: [m] } = await pool.query(`SELECT media_type, mime_type FROM client_media WHERE wa_message_id = 'wamid.ESP${n}'`);
    assert.deepEqual([m.media_type, m.mime_type], ['sticker', 'image/webp']);
  } finally { global.fetch = original; }
});

test('una reacción dice qué emoji puso y a qué mensaje', async () => {
  await pool.query(`INSERT INTO messages (wa_message_id, phone, direction, content) VALUES ('wamid.ORIG', $1, 'outbound', 'Su poder está listo')`, [PHONE]);
  const row = await send({ type: 'reaction', reaction: { emoji: '👍', message_id: 'wamid.ORIG' } });
  assert.equal(row.content, '👍 reaccionó a: "Su poder está listo"');
});

test('una reacción a un mensaje que no está en el panel, o quitada', async () => {
  assert.equal((await send({ type: 'reaction', reaction: { emoji: '❤️', message_id: 'wamid.NOEXISTE' } })).content, '❤️ reaccionó a un mensaje');
  assert.equal((await send({ type: 'reaction', reaction: { message_id: 'wamid.ORIG' } })).content, 'Quitó su reacción');
});

test('un contacto compartido muestra nombre y teléfono', async () => {
  const row = await send({ type: 'contacts', contacts: [{ name: { formatted_name: 'Pedro Pérez' }, phones: [{ phone: '+1 809-555-0199' }] }] });
  assert.equal(row.content, '👤 Contacto compartido: Pedro Pérez · +1 809-555-0199');
});

test('lo que WhatsApp no deja ver aquí se explica, según la razón', async () => {
  const uns = (type) => send({ type: 'unsupported', errors: [{ code: 131051, title: 'Message type unknown' }], ...(type ? { unsupported: { type } } : {}) });
  assert.match((await uns('edit')).content, /^✏️ .*editó un mensaje.*celular/);
  assert.match((await uns('view_once')).content, /^📵 .*ver una sola vez.*celular/);
  assert.match((await uns('poll_creation')).content, /^📊 .*encuesta.*celular/);
  assert.match((await uns(null)).content, /^📵 .*no deja ver aquí.*celular/);
});

test('ninguno de estos hace que el bot conteste (no traen texto para él)', () => {
  for (const m of [
    { type: 'reaction', reaction: { emoji: '👍', message_id: 'x' } },
    { type: 'sticker', sticker: { id: 's1' } },
    { type: 'unsupported', errors: [{ code: 131051 }], unsupported: { type: 'edit' } },
    { type: 'contacts', contacts: [{ name: { formatted_name: 'X' } }] },
  ]) assert.equal(cloudHandler.normalizeMessage({ id: 'm', from: PHONE, ...m }, {}).text, '');
});

test('una reacción que Leandro pone desde el teléfono también se lee bien', async () => {
  await cloudHandler.processWebhookPayload({ entry: [{ changes: [{ field: 'smb_message_echoes', value: {
    metadata: META,
    message_echoes: [{ from: '18298049017', to: PHONE, id: 'wamid.ECOREAC', timestamp: '1762700000', type: 'reaction', reaction: { emoji: '🙏', message_id: 'wamid.NOEXISTE' } }],
  } }] }] });
  const { rows: [m] } = await pool.query(`SELECT content, direction FROM messages WHERE wa_message_id = 'wamid.ECOREAC'`);
  assert.deepEqual([m.content, m.direction], ['🙏 reaccionó a un mensaje', 'outbound']);
});
