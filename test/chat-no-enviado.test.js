// Chat en modo manual con la API de Meta: si un mensaje del digitador no sale, el panel tiene que saberlo.
// Al enviar: 409 WINDOW_CLOSED (24 h) o 502 SEND_FAILED, sin guardar el mensaje como enviado.
// Después: un status "failed" del webhook marca el mensaje del chat (failed_window o failed).
process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG-test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-chat-fail-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const { generateToken } = require('../src/middleware/auth');
const outgoing = require('../src/whatsapp/outgoing');
const cloudHandler = require('../src/whatsapp/cloudHandler');

const PHONE = '18095550001';
let server, base, tok, sendImpl;
const origError = console.error;

outgoing.isAvailable = () => true;
outgoing.sendText = async () => sendImpl();
outgoing.sendMedia = async () => sendImpl();

test.before(async () => {
  console.error = (...a) => { if (process.env.DBG) origError(...a); };
  const app = express();
  app.use(express.json());
  app.use('/api/messages', require('../src/routes/messages'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/messages`;
});
test.after(async () => { console.error = origError; server.close(); await pool.end(); });
test.beforeEach(async () => {
  await createAgentSchema();
  await pool.query('DROP TABLE IF EXISTS activity_log, portfolio_versions, portfolio_documents CASCADE');
  await pool.query('CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  await runSqlFile('migrations/20261007_delivery_wa_id.sql');
  const id = await createUser('hengi', 'digitador', 'Hengi');
  tok = generateToken({ id, username: 'hengi', email: 'h@t.co', role: 'digitador' });
  sendImpl = async () => ({ key: { id: 'wamid.OK' } });
});

const windowClosed = () => Object.assign(new Error('ventana'), { code: 'WINDOW_CLOSED' });
const outbound = async () => (await pool.query(`SELECT content, status FROM messages WHERE direction = 'outbound' ORDER BY id`)).rows;
const sendText = (content) => fetch(`${base}/send-direct`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
  body: JSON.stringify({ phone: PHONE, content }),
});
const sendFile = () => {
  const form = new FormData();
  form.append('phone', PHONE);
  form.append('file', new Blob(['hola'], { type: 'application/pdf' }), 'x.pdf');
  return fetch(`${base}/send-media`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` }, body: form });
};

test('mensaje fuera de las 24 h: 409 WINDOW_CLOSED con aviso claro y no queda como enviado', async () => {
  sendImpl = async () => { throw windowClosed(); };
  const res = await sendText('Buenas, ¿le llegó el documento?');
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, 'WINDOW_CLOSED');
  assert.match(body.error, /no se envió.*24 h/i);
  assert.deepEqual(await outbound(), []);
});

test('otro fallo al enviar: 502 SEND_FAILED', async () => {
  sendImpl = async () => { throw new Error('Graph API 500 error'); };
  const res = await sendText('Hola');
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, 'SEND_FAILED');
  assert.deepEqual(await outbound(), []);
});

test('archivo fuera de las 24 h: también 409 WINDOW_CLOSED', async () => {
  sendImpl = async () => { throw windowClosed(); };
  const res = await sendFile();
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, 'WINDOW_CLOSED');
});

test('enviado bien: 201 y guardado como sent', async () => {
  const res = await sendText('Hola');
  assert.equal(res.status, 201);
  assert.deepEqual(await outbound(), [{ content: 'Hola', status: 'sent' }]);
});

test('Meta avisa después que no lo entregó: el mensaje del chat queda marcado', async () => {
  for (const [id, content] of [['wamid.A', 'fuera de ventana'], ['wamid.B', 'no entregable'], ['wamid.C', 'entregado']]) {
    await pool.query(`INSERT INTO messages (wa_message_id, phone, direction, content, status) VALUES ($1, $2, 'outbound', $3, 'sent')`, [id, PHONE, content]);
  }
  await pool.query(`INSERT INTO messages (wa_message_id, phone, direction, content, status) VALUES ('wamid.IN', $1, 'inbound', 'hola', 'received')`, [PHONE]);
  const failed = (id, code) => ({ id, status: 'failed', timestamp: '1759760000', recipient_id: PHONE, errors: [{ code, title: 'x' }] });
  await cloudHandler.processWebhookPayload({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp',
      metadata: { display_phone_number: '1809', phone_number_id: '111222333' },
      statuses: [failed('wamid.A', 131047), failed('wamid.B', 130472), { id: 'wamid.C', status: 'delivered', timestamp: '1759760000', recipient_id: PHONE },
        failed('wamid.IN', 131047)] } }] }],
  });
  assert.deepEqual(await outbound(), [
    { content: 'fuera de ventana', status: 'failed_window' },
    { content: 'no entregable', status: 'failed' },
    { content: 'entregado', status: 'sent' },
  ]);
  const inbound = (await pool.query(`SELECT status FROM messages WHERE direction = 'inbound'`)).rows[0];
  assert.equal(inbound.status, 'received');
});
