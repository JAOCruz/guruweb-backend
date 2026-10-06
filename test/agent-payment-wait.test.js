// Fase 2, tarea 5: avisar_pago (aviso de comprobante a los admins, sin tocar cotizaciones), la espera del lote
// en los chats del agente (8 s desde el último mensaje, tope de 30 s desde el primero; el motor viejo sigue con
// 3 s) y las secciones nuevas de la guía (carrito, documentos, comprobantes, cambios de tema).
process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-wa-'));
const fs = require('fs');
const path = require('path');
const { pool } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS, runTool } = require('../src/agent/tools');
const { avisar_pago } = require('../src/agent/tools/payment');
const { clearCache } = require('../src/agent/businessInfo');
const handler = require('../src/whatsapp/handler');

const PHONE = '18095550144';
const AGENT = '18095550155';
const LEGACY = '18095550166';
const GUIDE = path.join(__dirname, '..', 'src', 'agent', 'guide.md');
let ctx, botUserId, clientId, admins;

test.beforeEach(async () => {
  ({ botUserId } = await createAgentSchema());
  clearCache();
  admins = [await createUser('adm1', 'admin', 'Admin Uno'), await createUser('adm2', 'admin', 'Admin Dos')];
  const inactive = await createUser('adm3', 'admin', 'Admin Baja');
  await pool.query('UPDATE users SET is_active = false WHERE id = $1', [inactive]);
  await createUser('dig', 'digitador', 'Digi Tador');
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Ana Cliente') RETURNING id`, [PHONE])).rows[0].id;
  const client = (await pool.query('SELECT * FROM clients WHERE id=$1', [clientId])).rows[0];
  ctx = { phone: PHONE, client, botUserId, now: new Date(), lastText: '', toolLogIds: [] };
});
test.after(async () => { await pool.end(); });

const notifs = async () => (await pool.query(`SELECT * FROM notifications WHERE type='payment' ORDER BY user_id`)).rows;
const invoice = async (status, minutesAgo) => (await pool.query(
  `INSERT INTO invoices (status, client_id, total, created_at) VALUES ($1, $2, 100, NOW() - ($3 || ' minutes')::interval) RETURNING id`,
  [status, clientId, String(minutesAgo)])).rows[0].id;

// ---------- avisar_pago ----------

test('avisar_pago avisa a los admins con monto y cotización, sin cambiar el estado', async () => {
  const paid = await invoice('paid', 60);
  const approved = await invoice('approved', 30);
  const sent = await invoice('sent', 20);
  const rejected = await invoice('rejected', 5); // más nueva, pero no está abierta
  const r = await avisar_pago({ monto: 'RD$ 950', banco: 'Banreservas', referencia: 'TRX-123', media_id: 7 }, ctx);
  assert.deepEqual(r, { avisado: true });

  const n = await notifs();
  assert.deepEqual(n.map((x) => x.user_id), admins, 'solo los admins activos');
  for (const x of n) {
    assert.equal(x.title, '💵 Comprobante de pago: Ana Cliente');
    assert.match(x.message, /RD\$ 950/);
    assert.match(x.message, /Banreservas/);
    assert.match(x.message, /TRX-123/);
    assert.doesNotMatch(x.message, /Ana Cliente|cédula/i, 'el mensaje no lleva otros datos del cliente');
    assert.equal(x.link, `/bot-messages?phone=${PHONE}`);
    assert.deepEqual(x.metadata, { phone: PHONE, media_id: 7, invoice_id: sent });
  }
  const rows = (await pool.query('SELECT id, status FROM invoices ORDER BY id')).rows;
  assert.deepEqual(rows, [{ id: paid, status: 'paid' }, { id: approved, status: 'approved' }, { id: sent, status: 'sent' }, { id: rejected, status: 'rejected' }]);
});

test('avisar_pago sin datos leídos ni cotización: título con el teléfono, invoice_id nulo, mensaje sin huecos', async () => {
  await pool.query('UPDATE clients SET name = $1 WHERE id = $2', [PHONE, clientId]);
  ctx.client.name = PHONE;
  await invoice('paid', 10);
  const r = await runTool('avisar_pago', {}, ctx);
  assert.deepEqual(r, { avisado: true });
  const n = await notifs();
  assert.equal(n.length, 2);
  assert.equal(n[0].title, `💵 Comprobante de pago: ${PHONE}`);
  assert.doesNotMatch(n[0].message, /undefined|null/);
  assert.deepEqual(n[0].metadata, { phone: PHONE, media_id: null, invoice_id: null });
  const l = (await pool.query('SELECT herramienta, ok FROM bot_tool_log')).rows;
  assert.deepEqual(l, [{ herramienta: 'avisar_pago', ok: true }]);
});

test('avisar_pago está registrada: 12 herramientas, sin argumentos obligatorios', () => {
  assert.equal(TOOLS.length, 12);
  const t = TOOLS.find((x) => x.name === 'avisar_pago');
  assert.ok(t, 'falta avisar_pago');
  assert.deepEqual(t.parameters.required, []);
  assert.match(t.description, /comprobante/i);
  assert.match(t.description, /nunca confirm/i);
});

// ---------- espera del lote ----------

const payload = (phone, text, media = null) => ({ msg: { key: { remoteJid: `${phone}@s.whatsapp.net` } }, text, savedMedia: media, willRespond: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sock = {};

test.describe('espera del lote', () => {
  let batches;
  test.beforeEach(() => {
    process.env.BOT_ENGINE = 'legacy';
    process.env.BOT_AGENT_PHONES = AGENT;
    batches = [];
    handler._setBatchProcessor(async (phone, batch) => { batches.push({ phone, batch, at: Date.now() }); });
    handler._setBufferTiming({ agentMs: 60, agentMaxMs: 200, legacyMs: 40 });
  });
  test.afterEach(() => {
    handler._setBatchProcessor(null);
    handler._setBufferTiming(null);
    delete process.env.BOT_AGENT_PHONES;
  });

  test('las constantes son 8 s, 30 s y 3 s', () => {
    assert.deepEqual(handler.BUFFER_TIMING, { AGENT_BUFFER_MS: 8000, AGENT_BUFFER_MAX_MS: 30000, MESSAGE_BUFFER_MS: 3000 });
  });

  test('chat con agente: tres fotos en 20 s y un texto → un solo lote con las tres', async () => {
    const t0 = Date.now();
    handler.bufferMessage(AGENT, payload(AGENT, '', { id: 1, media_type: 'image' }), sock);
    await sleep(30);
    handler.bufferMessage(AGENT, payload(AGENT, '', { id: 2, media_type: 'image' }), sock);
    await sleep(30);
    handler.bufferMessage(AGENT, payload(AGENT, '', { id: 3, media_type: 'image' }), sock);
    await sleep(30);
    assert.equal(batches.length, 0, 'cada mensaje reinicia la espera');
    handler.bufferMessage(AGENT, payload(AGENT, 'quiero un acto de venta'), sock);
    await sleep(30);
    assert.equal(batches.length, 0);
    await sleep(60);
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].batch.map((b) => b.savedMedia?.id || b.text), [1, 2, 3, 'quiero un acto de venta']);
    assert.ok(batches[0].at - t0 >= 90 + 60, 'se procesa después de la espera desde el último mensaje');
  });

  test('el lote nunca espera más de 30 s desde el primer mensaje', async () => {
    const t0 = Date.now();
    let i = 0;
    const iv = setInterval(() => handler.bufferMessage(AGENT, payload(AGENT, `m${++i}`), sock), 25);
    await sleep(330);
    clearInterval(iv);
    await sleep(100);
    assert.ok(batches.length >= 2, `el tope cerró el primer lote aunque siguieran llegando mensajes (${batches.length} lotes)`);
    const first = batches[0];
    assert.ok(first.at - t0 >= 200 && first.at - t0 < 300, `primer lote a los ${first.at - t0} ms`);
    assert.ok(first.batch.length >= 6 && first.batch.length <= 9, `el primer lote lleva lo que llegó en el tope (${first.batch.length})`);
    const all = batches.flatMap((b) => b.batch.map((m) => m.text));
    assert.deepEqual(all, Array.from({ length: i }, (_, k) => `m${k + 1}`), 'ningún mensaje se pierde ni se repite');
  });

  test('chat legacy sigue con 3 s (aquí 40 ms): no se reinicia a 8 s ni espera el tope', async () => {
    const t0 = Date.now();
    handler.bufferMessage(LEGACY, payload(LEGACY, 'hola'), sock);
    await sleep(20);
    handler.bufferMessage(LEGACY, payload(LEGACY, 'buenas'), sock);
    await sleep(70);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].phone, LEGACY);
    assert.deepEqual(batches[0].batch.map((b) => b.text), ['hola', 'buenas']);
    assert.ok(batches[0].at - t0 < 100, `legacy se procesó a los ${batches[0].at - t0} ms`);
  });
});

// ---------- guía ----------

test('la guía menciona el carrito, avisar_pago y confirmar los datos antes de preparar_documento', () => {
  const g = fs.readFileSync(GUIDE, 'utf8');
  for (const needle of ['avisar_pago', 'ver_modelo', 'preparar_documento', 'carrito', '¿es todo?', 'el equipo lo verifica',
    'otra parte', 'retom']) {
    assert.ok(g.toLowerCase().includes(needle.toLowerCase()), `falta "${needle}" en la guía`);
  }
  // El resumen de los datos se confirma antes de preparar_documento
  assert.match(g, /resumen[^\n]*confirm[^\n]*antes[^\n]*preparar_documento|confirm[^\n]*resumen[^\n]*antes[^\n]*preparar_documento/i);
  // Comprobantes: avisar_pago, nunca "confirmado"
  assert.match(g, /comprobante[^\n]*avisar_pago|avisar_pago[^\n]*comprobante/i);
  assert.doesNotMatch(g, /pago confirmado/i);
  // Sigue sin montos ni promesas de tiempo
  assert.equal(/RD\$\s?\d|\d[\d,.]*\s*pesos/i.test(g), false);
  assert.doesNotMatch(g, /confirm\w* (?:enseguida|en un momento|ahora mismo|de inmediato|hoy mismo)/i);
});
