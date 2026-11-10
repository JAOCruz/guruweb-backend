// Chats ocultos: solo el admin los ve, y si el contacto vuelve a escribir el chat reaparece solo con lo nuevo.
// También los mensajes que el negocio escribe desde la app del teléfono (smb_message_echoes).
process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG-test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-ocultos-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const { generateToken } = require('../src/middleware/auth');
const cloudApi = require('../src/whatsapp/cloudApi');
const cloudHandler = require('../src/whatsapp/cloudHandler');

const VIEJO = '18095550001';
const OTRO = '18095550002';
const MIGRATION = 'migrations/20261110_chats_ocultos.sql';
let server, base, admin, digi;

const msg = (phone, content, direction = 'inbound', ago = "'1 hour'") => pool.query(
  `INSERT INTO messages (phone, direction, content, created_at, read) VALUES ($1, $2, $3, NOW() - INTERVAL ${ago}, FALSE)`, [phone, direction, content]);
const call = async (method, p, tok) => {
  const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${tok}` } });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const lista = async (tok, q = '') => (await call('GET', `/conversations${q}`, tok)).body.conversations;
const chat = async (phone, tok, q = '') => (await call('GET', `/phone/${phone}${q}`, tok)).body.messages.map((m) => m.content);
const webhook = (value) => cloudHandler.processWebhookPayload({ entry: [{ changes: [{ field: 'smb_message_echoes', value }] }] });
const META = { phone_number_id: '111222333' };

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/messages', require('../src/routes/messages'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/messages`;
});
test.after(async () => { server.close(); await pool.end(); });
test.beforeEach(async () => {
  await createAgentSchema();
  await pool.query('DROP TABLE IF EXISTS hidden_chats, activity_log, portfolio_versions, portfolio_documents CASCADE');
  await pool.query('CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL');
  await pool.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS profile_pic_url TEXT');
  await pool.query('ALTER TABLE client_media ADD COLUMN IF NOT EXISTS original_name TEXT, ADD COLUMN IF NOT EXISTS saved_name TEXT, ADD COLUMN IF NOT EXISTS file_size INT, ADD COLUMN IF NOT EXISTS context TEXT, ADD COLUMN IF NOT EXISTS doc_request_id INT');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  const a = await createUser('leandro', 'admin', 'Leandro');
  const d = await createUser('hengi', 'digitador', 'Hengi');
  admin = generateToken({ id: a, username: 'leandro', email: 'a@x.com', role: 'admin' });
  digi = generateToken({ id: d, username: 'hengi', email: 'h@x.com', role: 'digitador' });
  await pool.query(`INSERT INTO clients (name, phone, assigned_to) VALUES ('Viejo', $1, $2)`, [VIEJO, d]);
  await msg(VIEJO, 'historial viejo');
  await runSqlFile(MIGRATION);
});

test('la migración oculta los chats que había y al repetirla no oculta los nuevos', async () => {
  await msg(OTRO, 'nuevo', 'inbound', "'0 seconds'");
  await pool.query(`UPDATE hidden_chats SET hidden_at = NOW() - INTERVAL '10 minutes'`);
  await runSqlFile(MIGRATION);
  const { rows } = await pool.query('SELECT phone FROM hidden_chats');
  assert.deepEqual(rows.map((r) => r.phone), [VIEJO]);
});

test('un chat oculto no sale en la lista de nadie ni cuenta en los no leídos', async () => {
  assert.deepEqual(await lista(admin), []);
  assert.deepEqual(await lista(digi), []);
  assert.equal(Number((await call('GET', '/unread-count', admin)).body.count), 0);
  assert.equal(Number((await call('GET', '/unread-count', digi)).body.count), 0);
});

test('si vuelve a escribir, reaparece mostrando solo lo nuevo', async () => {
  await pool.query(`UPDATE hidden_chats SET hidden_at = NOW() - INTERVAL '10 minutes'`);
  await msg(VIEJO, 'hola otra vez', 'inbound', "'0 seconds'");
  const [c] = await lista(digi);
  assert.equal(c.phone, VIEJO);
  assert.equal(Number(c.message_count), 1);
  assert.deepEqual(await chat(VIEJO, digi), ['hola otra vez']);
  assert.equal(Number((await call('GET', '/unread-count', digi)).body.count), 1);
});

test('solo el admin ve los ocultos, con todo su historial', async () => {
  const ocultos = await lista(admin, '?hidden=1');
  assert.equal(ocultos.length, 1);
  assert.equal(ocultos[0].hidden, true);
  assert.deepEqual(await chat(VIEJO, admin, '?hidden=1'), ['historial viejo']);
  assert.equal((await call('GET', '/conversations?hidden=1', digi)).status, 403);
  assert.deepEqual(await chat(VIEJO, digi, '?hidden=1'), []);
});

test('la búsqueda no encuentra lo oculto', async () => {
  assert.deepEqual((await call('GET', '/search?q=historial', digi)).body.conversations, []);
});

test('ocultar y mostrar: solo el admin, y al mostrar vuelve todo el historial', async () => {
  assert.equal((await call('POST', `/phone/${VIEJO}/unhide`, digi)).status, 403);
  assert.equal((await call('POST', `/phone/${VIEJO}/unhide`, admin)).status, 200);
  assert.equal((await lista(digi)).length, 1);
  assert.deepEqual(await chat(VIEJO, digi), ['historial viejo']);
  assert.equal((await call('POST', `/phone/${VIEJO}/hide`, digi)).status, 403);
  assert.equal((await call('POST', `/phone/${VIEJO}/hide`, admin)).status, 200);
  assert.deepEqual(await lista(admin), []);
});

test('volver a ocultar un chat que reapareció también esconde lo nuevo', async () => {
  await pool.query(`UPDATE hidden_chats SET hidden_at = NOW() - INTERVAL '10 minutes'`);
  await msg(VIEJO, 'hola otra vez', 'inbound', "'1 minute'");
  assert.equal((await lista(admin)).length, 1);
  await call('POST', `/phone/${VIEJO}/hide`, admin);
  assert.deepEqual(await lista(admin), []);
});

// ── Lo que se escribe desde la app del teléfono ──
const echo = (over = {}) => ({ from: '18298049017', to: OTRO, id: 'wamid.eco1', timestamp: '1762700000', type: 'text', text: { body: 'Le escribo desde el teléfono' }, ...over });

test('un mensaje escrito desde el teléfono entra como enviado en el chat del cliente, una sola vez', async () => {
  await webhook({ metadata: META, message_echoes: [echo()] });
  await webhook({ metadata: META, message_echoes: [echo()] });
  const { rows } = await pool.query(`SELECT * FROM messages WHERE wa_message_id = 'wamid.eco1'`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, OTRO);
  assert.equal(rows[0].direction, 'outbound');
  assert.equal(rows[0].content, 'Le escribo desde el teléfono');
  assert.equal(rows[0].read, true);
  assert.equal(Number((await call('GET', '/unread-count', admin)).body.count), 0);
});

test('el mensaje del teléfono se liga al cliente registrado', async () => {
  await webhook({ metadata: META, message_echoes: [echo({ to: VIEJO })] });
  const { rows: [m] } = await pool.query(`SELECT m.client_id, c.phone FROM messages m JOIN clients c ON c.id = m.client_id WHERE m.wa_message_id = 'wamid.eco1'`);
  assert.equal(m.phone, VIEJO);
});

test('una foto escrita desde el teléfono guarda el archivo', async () => {
  const orig = { url: cloudApi.getMediaUrl, dl: cloudApi.downloadMedia };
  cloudApi.getMediaUrl = async () => ({ url: 'https://x/y', mime_type: 'image/jpeg' });
  cloudApi.downloadMedia = async () => Buffer.from('foto');
  try {
    await webhook({ metadata: META, message_echoes: [echo({ type: 'image', text: undefined, image: { id: 'm1', mime_type: 'image/jpeg', caption: 'su recibo' } })] });
  } finally { cloudApi.getMediaUrl = orig.url; cloudApi.downloadMedia = orig.dl; }
  const { rows: [m] } = await pool.query(`SELECT content, media_url FROM messages WHERE wa_message_id = 'wamid.eco1'`);
  assert.match(m.content, /su recibo/);
  assert.match(m.media_url, /^\/api\/media\/\d+\/download$/);
});

test('el eco de otro número se ignora', async () => {
  await webhook({ metadata: { phone_number_id: '999' }, message_echoes: [echo()] });
  assert.equal((await pool.query(`SELECT 1 FROM messages WHERE wa_message_id = 'wamid.eco1'`)).rowCount, 0);
});

test('un mensaje desde el teléfono hace reaparecer un chat oculto', async () => {
  await pool.query(`UPDATE hidden_chats SET hidden_at = NOW() - INTERVAL '10 minutes'`);
  await webhook({ metadata: META, message_echoes: [echo({ to: VIEJO })] });
  assert.deepEqual(await chat(VIEJO, admin), ['Le escribo desde el teléfono']);
});
