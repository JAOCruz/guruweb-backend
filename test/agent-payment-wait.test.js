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
const sock = {};

// Relojes simulados de node:test (setTimeout y Date): los lotes se miden con las constantes reales (8 s, 30 s, 3 s)
// sin esperar de verdad. El procesador del lote se reemplaza para ver los lotes sin correr el motor.
test.describe('espera del lote', () => {
  const T0 = 1_700_000_000_000;
  let batches, env;
  const clock = (t) => { t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: T0 }); return t.mock.timers; };
  const at = (b) => b.at - T0;

  test.beforeEach(() => {
    env = { BOT_ENGINE: process.env.BOT_ENGINE, BOT_AGENT_PHONES: process.env.BOT_AGENT_PHONES };
    process.env.BOT_ENGINE = 'legacy';
    process.env.BOT_AGENT_PHONES = AGENT;
    batches = [];
    handler._setBatchProcessor(async (phone, batch) => { batches.push({ phone, batch, at: Date.now() }); });
  });
  test.afterEach(() => {
    handler._setBatchProcessor(null);
    for (const k of ['BOT_ENGINE', 'BOT_AGENT_PHONES']) {
      if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
    }
  });

  test('las constantes son 8 s, 30 s y 3 s', () => {
    assert.deepEqual(handler.BUFFER_TIMING, { AGENT_BUFFER_MS: 8000, AGENT_BUFFER_MAX_MS: 30000, MESSAGE_BUFFER_MS: 3000 });
  });

  test('chat con agente: tres fotos en 20 s y un texto → un solo lote con las tres', (t) => {
    const timers = clock(t);
    handler.bufferMessage(AGENT, payload(AGENT, '', { id: 1, media_type: 'image' }), sock);
    timers.tick(7000);
    handler.bufferMessage(AGENT, payload(AGENT, '', { id: 2, media_type: 'image' }), sock);
    timers.tick(7000);
    handler.bufferMessage(AGENT, payload(AGENT, '', { id: 3, media_type: 'image' }), sock);
    timers.tick(6000); // 20 s después de la primera foto
    assert.equal(batches.length, 0, 'cada medio reinicia la espera: a los 7 s no se había cerrado');
    handler.bufferMessage(AGENT, payload(AGENT, 'quiero un acto de venta'), sock);
    timers.tick(7999);
    assert.equal(batches.length, 0, 'el texto también reinicia la espera');
    timers.tick(1);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].phone, AGENT);
    assert.deepEqual(batches[0].batch.map((b) => b.savedMedia?.id || b.text), [1, 2, 3, 'quiero un acto de venta']);
    assert.equal(at(batches[0]), 28000, 'se procesa 8 s después del último mensaje');
    timers.tick(60000);
    assert.equal(batches.length, 1, 'un solo lote');
  });

  test('el lote nunca espera más de 30 s desde el primer mensaje', (t) => {
    const timers = clock(t);
    // Un mensaje cada 5 s: sin tope, el lote se seguiría corriendo para siempre.
    for (let i = 1; i <= 6; i++) {
      handler.bufferMessage(AGENT, payload(AGENT, `m${i}`), sock);
      if (i < 6) timers.tick(5000);
    }
    // El sexto llegó a los 25 s: sin tope se procesaría a los 33 s; con el tope, a los 30 s.
    timers.tick(4999);
    assert.equal(batches.length, 0);
    timers.tick(1);
    assert.equal(batches.length, 1);
    assert.equal(at(batches[0]), 30000, 'el tope cierra el lote a los 30 s del primer mensaje');
    assert.deepEqual(batches[0].batch.map((b) => b.text), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
    // Lo que llega después abre otro lote, con su propia espera de 8 s y su propio tope.
    handler.bufferMessage(AGENT, payload(AGENT, 'm7'), sock);
    timers.tick(5000);
    handler.bufferMessage(AGENT, payload(AGENT, 'm8'), sock);
    timers.tick(7999);
    assert.equal(batches.length, 1);
    timers.tick(1);
    assert.equal(batches.length, 2);
    assert.deepEqual(batches[1].batch.map((b) => b.text), ['m7', 'm8']);
    assert.equal(at(batches[1]), 30000 + 5000 + 8000);
    timers.tick(60000);
    assert.equal(batches.length, 2, 'ningún mensaje se pierde ni se repite');
  });

  test('chat legacy sigue con 3 s: no se reinicia a 8 s ni espera el tope', (t) => {
    const timers = clock(t);
    handler.bufferMessage(LEGACY, payload(LEGACY, 'hola'), sock);
    timers.tick(2000);
    handler.bufferMessage(LEGACY, payload(LEGACY, 'buenas'), sock);
    timers.tick(2999);
    assert.equal(batches.length, 0, 'cada mensaje reinicia los 3 s');
    timers.tick(1);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].phone, LEGACY);
    assert.deepEqual(batches[0].batch.map((b) => b.text), ['hola', 'buenas']);
    assert.equal(at(batches[0]), 5000, '3 s después del último mensaje, no 8');
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
