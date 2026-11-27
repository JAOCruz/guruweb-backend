// Seguimiento de cotizaciones (Leandro, 2026-10-27): si se le envió la cotización o la factura al cliente y no
// contesta, el bot le escribe una sola vez para darle seguimiento, en horario.
// Jay, 2026-11-27: Meta solo deja escribir hasta 24 h después del último mensaje del cliente, así que el
// seguimiento sale a las 22 h de ese mensaje (dentro del plazo) y, si ya pasaron 23 h, no se intenta. Hay
// interruptor general y por cliente, y solo va a chats que atiende el bot.
const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const followup = require('../src/agent/followup');
const { clearCache } = require('../src/agent/businessInfo');

const PHONE = '18095550001';
// martes 27 de octubre de 2026, 3:00 p.m. en Santo Domingo (abierto)
const NOW = new Date('2026-10-27T19:00:00Z');
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000);

let sent, sendImpl, adminId, clientId;
let owns;
followup._setDeps({ botOwns: (phone) => owns(phone) });
followup._setSender({
  sendText: async (to, text) => {
    sent.push({ to, text });
    return sendImpl ? sendImpl() : { key: { id: `wa-${sent.length}` } };
  },
});

test.beforeEach(async () => {
  sent = [];
  sendImpl = null;
  owns = () => true;
  clearCache();
  await createAgentSchema();
  await pool.query('ALTER TABLE invoices ADD COLUMN sent_at TIMESTAMPTZ');
  await pool.query('CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL');
  await pool.query('DROP TABLE IF EXISTS activity_log CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20261027_politicas_seguimiento.sql');
  await runSqlFile('migrations/20261127_seguimiento_interruptores.sql');
  adminId = await createUser('leandro', 'admin', 'Leandro');
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Yadily Pérez') RETURNING id`, [PHONE])).rows[0].id;
});
test.after(async () => { await pool.end(); });

async function makeInvoice({ sentAt = hoursAgo(20), status = 'sent', type = 'COTIZACIÓN', doc = 'COT-2026-001' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO invoices (doc_number, type, status, client_id, client_name, client_phone, items, subtotal, itbis, total, created_by, source, sent_at)
     VALUES ($1, $2, $3, $4, 'Yadily Pérez', $5, '[]', 2500, 0, 2500, $6, 'bot', $7) RETURNING *`,
    [doc, type, status, clientId, PHONE, adminId, sentAt]);
  return rows[0];
}
const inbound = (at, text = 'hola') => pool.query(
  `INSERT INTO messages (phone, client_id, direction, content, wa_jid, created_at) VALUES ($1, $2, 'inbound', $3, $4, $5)`,
  [PHONE, clientId, text, `${PHONE}@s.whatsapp.net`, at]);

test('22 h después del último mensaje del cliente: un solo seguimiento, guardado en el chat y avisado al equipo', async () => {
  await inbound(hoursAgo(22.5), 'ok, mándemela');
  const inv = await makeInvoice();
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 1 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, `${PHONE}@s.whatsapp.net`);
  assert.match(sent[0].text, /^Saludos y muy buenas tardes!!/);
  assert.match(sent[0].text, /seguimiento a la cotización COT-2026-001/);
  const out = (await pool.query(`SELECT content, wa_message_id FROM messages WHERE direction = 'outbound'`)).rows;
  assert.deepEqual(out, [{ content: sent[0].text, wa_message_id: 'wa-1' }]);
  const row = (await pool.query('SELECT followup_at, followup_error FROM invoices WHERE id = $1', [inv.id])).rows[0];
  assert.ok(row.followup_at);
  assert.equal(row.followup_error, null);
  const notes = (await pool.query('SELECT user_id, title, link FROM notifications')).rows;
  assert.deepEqual(notes, [{ user_id: adminId, title: '🔔 Seguimiento enviado: COT-2026-001', link: `/cotizaciones?invoice=${inv.id}` }]);
  // la segunda pasada no repite
  assert.deepEqual(await followup.processFollowups(new Date(NOW.getTime() + 600 * 1000)), { sent: 0 });
  assert.equal(sent.length, 1);
});

test('una factura sin pagar habla del pago pendiente', async () => {
  await inbound(hoursAgo(22.5));
  await makeInvoice({ type: 'FACTURA', doc: 'FAC-2026-009' });
  await followup.processFollowups(NOW);
  assert.match(sent[0].text, /seguimiento a su factura FAC-2026-009/);
  assert.match(sent[0].text, /pago/);
});

test('no escribe si el cliente respondió, ya pagó o fue rechazada', async () => {
  await inbound(hoursAgo(22.5));
  await makeInvoice({ doc: 'COT-2', status: 'paid' });
  await makeInvoice({ doc: 'COT-3', status: 'rejected' });
  await makeInvoice({ doc: 'COT-1' });
  await inbound(hoursAgo(10), 'gracias, lo reviso'); // respondió después de la cotización
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 });
  assert.equal(sent.length, 0);
});

test('antes de 22 h todavía no; recién enviada tampoco', async () => {
  await inbound(hoursAgo(10));
  await makeInvoice({ sentAt: hoursAgo(9) });
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 });
  await pool.query('DELETE FROM invoices; DELETE FROM messages');
  await inbound(hoursAgo(22.5));
  await makeInvoice({ sentAt: hoursAgo(0.2) }); // se la mandaron hace 12 minutos
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 });
  assert.equal(sent.length, 0);
});

test('pasadas las 23 h no lo intenta (Meta no lo deja): ni «No enviado» ni error', async () => {
  await inbound(hoursAgo(26));
  const inv = await makeInvoice({ sentAt: hoursAgo(25) });
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 });
  assert.equal(sent.length, 0);
  const row = (await pool.query('SELECT followup_at, followup_error FROM invoices WHERE id = $1', [inv.id])).rows[0];
  assert.deepEqual(row, { followup_at: null, followup_error: null });
});

test('si el cliente nunca escribió, no hay plazo abierto: no lo intenta', async () => {
  await makeInvoice();
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 });
  assert.equal(sent.length, 0);
});

test('fuera de horario espera; el interruptor general lo apaga; las horas se pueden bajar', async () => {
  const sunday = new Date('2026-10-25T19:00:00Z');
  assert.deepEqual(await followup.processFollowups(sunday), { sent: 0, cerrado: true });

  await pool.query(`UPDATE business_info SET valor = '{"activo": false, "horas": 24}' WHERE clave = 'seguimiento_cotizaciones'`);
  clearCache();
  await inbound(hoursAgo(22.5));
  await makeInvoice();
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0, apagado: true });

  await pool.query('DELETE FROM invoices; DELETE FROM messages');
  await pool.query(`UPDATE business_info SET valor = '{"activo": true, "horas": 18}' WHERE clave = 'seguimiento_cotizaciones'`);
  clearCache();
  await inbound(hoursAgo(19));
  await makeInvoice({ sentAt: hoursAgo(18) });
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 1 });
});

test('«horas» de más de 22 se toma como 22 (si no, nunca saldría)', async () => {
  // la configuración guardada en producción es {"activo": true, "horas": 24}
  await inbound(hoursAgo(22.5));
  await makeInvoice();
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 1 });
});

test('un cliente con el seguimiento apagado no lo recibe', async () => {
  await pool.query('UPDATE clients SET followup_off = true WHERE id = $1', [clientId]);
  await inbound(hoursAgo(22.5));
  const inv = await makeInvoice();
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 });
  assert.equal(sent.length, 0);
  assert.equal((await pool.query('SELECT followup_at FROM invoices WHERE id = $1', [inv.id])).rows[0].followup_at, null);
});

test('solo en chats que atiende el bot: los de los digitadores no reciben seguimiento automático', async () => {
  owns = () => false;
  await inbound(hoursAgo(22.5));
  await makeInvoice();
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 });
  assert.equal(sent.length, 0);
});

test('si WhatsApp falla queda anotado y no se reintenta', async () => {
  await inbound(hoursAgo(22.5));
  const inv = await makeInvoice();
  sendImpl = () => { const e = new Error('closed'); e.code = 'WINDOW_CLOSED'; throw e; };
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 });
  const row = (await pool.query('SELECT followup_at, followup_error FROM invoices WHERE id = $1', [inv.id])).rows[0];
  assert.ok(row.followup_at);
  assert.equal(row.followup_error, 'WINDOW_CLOSED');
  sendImpl = null;
  await followup.processFollowups(new Date(NOW.getTime() + 600 * 1000));
  assert.equal(sent.length, 1, 'solo el intento fallido');
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM messages WHERE direction = 'outbound'`)).rows[0].n, 0);
});

test('el punto de entrada real (src/index.js) arranca el seguimiento', () => {
  // server.js no se usa en producción: el seguimiento estuvo ahí y nunca corrió (2026-10-28)
  const pkg = require('../package.json');
  assert.equal(pkg.main, 'src/index.js');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(src, /require\("\.\/agent\/followup"\)\.startFollowups\(\)/);
  const timer = followup.startFollowups(60 * 60 * 1000);
  assert.ok(timer);
  clearInterval(timer);
});

test('con BOT_FORZAR_APAGADO no le escribe al cliente ni gasta el seguimiento', async () => {
  await inbound(hoursAgo(22.5));
  const inv = await makeInvoice();
  process.env.BOT_FORZAR_APAGADO = 'true';
  try {
    assert.deepEqual(await followup.processFollowups(NOW), { sent: 0, apagado: true });
  } finally {
    delete process.env.BOT_FORZAR_APAGADO;
  }
  assert.equal(sent.length, 0);
  const { rows } = await pool.query('SELECT followup_at FROM invoices WHERE id = $1', [inv.id]);
  assert.equal(rows[0].followup_at, null);
});
