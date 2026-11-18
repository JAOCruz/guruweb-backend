// Contactos de WhatsApp con usuario (@nombre) que esconden su número: Meta manda su BSUID en vez del teléfono.
process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG-test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-bsuid-'));
const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const cloudApi = require('../src/whatsapp/cloudApi');
const cloudHandler = require('../src/whatsapp/cloudHandler');
const outgoing = require('../src/whatsapp/outgoing');
const { toContactId, isBsuid } = require('../src/whatsapp/contactId');

const BSUID = 'DO.' + '7'.repeat(60); // más largo que los 50 caracteres viejos
const META = { phone_number_id: '111222333' };
const webhook = (value) => cloudHandler.processWebhookPayload({ entry: [{ changes: [{ field: 'messages', value }] }] });
const MIGRATION = 'migrations/20261118_contactos_sin_numero.sql';

function mockFetch() {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => { calls.push({ url: String(url), body: typeof opts.body === 'string' ? JSON.parse(opts.body) : null }); return new Response(JSON.stringify({ id: 'media1', messages: [{ id: 'wamid.OUT' }] }), { status: 200 }); };
  return { calls, restore: () => { global.fetch = original; } };
}

test.before(async () => {
  await createAgentSchema();
  await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL');
  await pool.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS profile_pic_url TEXT');
  await runSqlFile(MIGRATION);
});
test.after(async () => { await pool.end(); });

test('el código del contacto se guarda tal cual; un teléfono sigue quedando solo en números', () => {
  assert.equal(toContactId(BSUID), BSUID);
  assert.equal(toContactId(`${BSUID}@s.whatsapp.net`), BSUID);
  assert.equal(toContactId('US.ENT.11815799212886844830'), 'US.ENT.11815799212886844830');
  assert.equal(toContactId('+1 (809) 555-0101'), '18095550101');
  assert.equal(toContactId('18095550101@s.whatsapp.net'), '18095550101');
  assert.ok(isBsuid(BSUID));
  assert.ok(!isBsuid('18095550101'));
});

test('la migración se puede correr dos veces', async () => {
  await runSqlFile(MIGRATION);
});

test('un mensaje de alguien sin número entra al chat con su código y su nombre', async () => {
  await webhook({
    metadata: META,
    contacts: [{ profile: { name: 'Miguel Jimenez', username: 'mrimpuestos' }, user_id: BSUID }],
    messages: [{ from_user_id: BSUID, id: 'wamid.SINNUM1', timestamp: String(Math.floor(Date.now() / 1000) - 3600), type: 'text', text: { body: 'Buenas, necesito un poder' } }],
  });
  const { rows } = await pool.query(`SELECT phone, direction, content, push_name FROM messages WHERE wa_message_id = 'wamid.SINNUM1'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, BSUID);
  assert.equal(rows[0].direction, 'inbound');
  assert.equal(rows[0].content, 'Buenas, necesito un poder');
  const { rows: [c] } = await pool.query('SELECT name FROM clients WHERE phone = $1', [BSUID]);
  assert.equal(c.name, 'Miguel Jimenez');
});

test('sin nombre de perfil, el chat se llama con su @usuario', async () => {
  const other = 'DO.' + '8'.repeat(30);
  await webhook({
    metadata: META,
    contacts: [{ profile: { username: 'soloalias' }, user_id: other }],
    messages: [{ from_user_id: other, id: 'wamid.SINNUM2', timestamp: String(Math.floor(Date.now() / 1000) - 3600), type: 'text', text: { body: 'hola' } }],
  });
  const { rows: [c] } = await pool.query('SELECT name FROM clients WHERE phone = $1', [other]);
  assert.equal(c.name, '@soloalias');
});

test('lo que Leandro escribe desde el teléfono a alguien sin número también entra', async () => {
  await cloudHandler.processWebhookPayload({ entry: [{ changes: [{ field: 'smb_message_echoes', value: {
    metadata: META,
    message_echoes: [{ from: '18298049017', to_user_id: BSUID, id: 'wamid.ECOSIN', timestamp: '1762700000', type: 'text', text: { body: 'Claro, le ayudo' } }],
  } }] }] });
  const { rows } = await pool.query(`SELECT phone, direction FROM messages WHERE wa_message_id = 'wamid.ECOSIN'`);
  assert.deepEqual(rows.map((r) => [r.phone, r.direction]), [[BSUID, 'outbound']]);
});

test('responder a alguien sin número usa «recipient» con su código (texto, imagen y documento)', async () => {
  const f = mockFetch();
  const file = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'x.pdf');
  fs.writeFileSync(file, '%PDF-1.4');
  try {
    await outgoing.sendText(`${BSUID}@s.whatsapp.net`, 'Hola');
    await cloudApi.sendImageMessage(BSUID, 'https://example.com/a.png');
    await cloudApi.sendDocumentMessage(BSUID, file, 'x.pdf');
    const sends = f.calls.filter((c) => c.url.endsWith('/messages'));
    assert.equal(sends.length, 3);
    for (const s of sends) {
      assert.equal(s.body.recipient, BSUID);
      assert.equal(s.body.to, undefined);
    }
  } finally { f.restore(); }
});

test('a un teléfono normal se le sigue enviando con «to»', async () => {
  const f = mockFetch();
  try {
    await outgoing.sendText('18095550101@s.whatsapp.net', 'Hola');
    assert.equal(f.calls[0].body.to, '18095550101');
    assert.equal(f.calls[0].body.recipient, undefined);
  } finally { f.restore(); }
});
