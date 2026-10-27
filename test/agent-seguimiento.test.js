// Seguimiento de cotizaciones (Leandro, 2026-10-27): si se le envió la cotización o la factura al cliente y
// pasa un día sin que escriba ni pague, el bot le escribe una sola vez para darle seguimiento, en horario.
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
followup._setSender({
  sendText: async (to, text) => {
    sent.push({ to, text });
    return sendImpl ? sendImpl() : { key: { id: `wa-${sent.length}` } };
  },
});

test.beforeEach(async () => {
  sent = [];
  sendImpl = null;
  clearCache();
  await createAgentSchema();
  await pool.query('ALTER TABLE invoices ADD COLUMN sent_at TIMESTAMPTZ');
  await pool.query('CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL');
  await pool.query('DROP TABLE IF EXISTS activity_log CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20261027_politicas_seguimiento.sql');
  adminId = await createUser('leandro', 'admin', 'Leandro');
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Yadily Pérez') RETURNING id`, [PHONE])).rows[0].id;
});
test.after(async () => { await pool.end(); });

async function makeInvoice({ sentAt = hoursAgo(25), status = 'sent', type = 'COTIZACIÓN', doc = 'COT-2026-001' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO invoices (doc_number, type, status, client_id, client_name, client_phone, items, subtotal, itbis, total, created_by, source, sent_at)
     VALUES ($1, $2, $3, $4, 'Yadily Pérez', $5, '[]', 2500, 0, 2500, $6, 'bot', $7) RETURNING *`,
    [doc, type, status, clientId, PHONE, adminId, sentAt]);
  return rows[0];
}
const inbound = (at, text = 'hola') => pool.query(
  `INSERT INTO messages (phone, client_id, direction, content, wa_jid, created_at) VALUES ($1, $2, 'inbound', $3, $4, $5)`,
  [PHONE, clientId, text, `${PHONE}@s.whatsapp.net`, at]);

test('un día sin respuesta: un solo mensaje de seguimiento, guardado en el chat y avisado al equipo', async () => {
  const inv = await makeInvoice();
  await inbound(hoursAgo(26), 'ok, mándemela');
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
  assert.deepEqual(await followup.processFollowups(new Date(NOW.getTime() + 3600 * 1000)), { sent: 0 });
  assert.equal(sent.length, 1);
});

test('una factura sin pagar habla del pago pendiente', async () => {
  await makeInvoice({ type: 'FACTURA', doc: 'FAC-2026-009' });
  await followup.processFollowups(NOW);
  assert.match(sent[0].text, /seguimiento a su factura FAC-2026-009/);
  assert.match(sent[0].text, /pago/);
});

test('no escribe si el cliente respondió, ya pagó, fue rechazada, aún no pasa un día o es vieja', async () => {
  const replied = await makeInvoice({ doc: 'COT-1' });
  await inbound(hoursAgo(10));
  await makeInvoice({ doc: 'COT-2', status: 'paid' });
  await makeInvoice({ doc: 'COT-3', status: 'rejected' });
  await makeInvoice({ doc: 'COT-4', sentAt: hoursAgo(5) });
  await makeInvoice({ doc: 'COT-5', sentAt: hoursAgo(24 * 5) });
  const r = await followup.processFollowups(NOW);
  assert.deepEqual(sent.map((x) => x.text.match(/(COT|FAC)-\S+/)?.[0]), []);
  assert.deepEqual(r, { sent: 0 });
  assert.ok(replied);
});

test('fuera de horario espera; apagado no escribe; las horas se pueden cambiar', async () => {
  await makeInvoice();
  const sunday = new Date('2026-10-25T19:00:00Z');
  await makeInvoice({ doc: 'COT-dom', sentAt: new Date(sunday.getTime() - 25 * 3600 * 1000) });
  assert.deepEqual(await followup.processFollowups(sunday), { sent: 0, cerrado: true });
  const night = new Date('2026-10-28T02:00:00Z'); // martes 10:00 p.m.
  assert.deepEqual(await followup.processFollowups(night), { sent: 0, cerrado: true });

  await pool.query(`DELETE FROM invoices WHERE doc_number = 'COT-dom'`);
  await pool.query(`UPDATE business_info SET valor = '{"activo": false, "horas": 24}' WHERE clave = 'seguimiento_cotizaciones'`);
  clearCache();
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0, apagado: true });

  await pool.query(`UPDATE business_info SET valor = '{"activo": true, "horas": 48}' WHERE clave = 'seguimiento_cotizaciones'`);
  clearCache();
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 }); // 25 h < 48 h
  assert.equal(sent.length, 0);
});

test('si WhatsApp falla queda anotado y no se reintenta', async () => {
  const inv = await makeInvoice();
  sendImpl = () => { const e = new Error('closed'); e.code = 'WINDOW_CLOSED'; throw e; };
  assert.deepEqual(await followup.processFollowups(NOW), { sent: 0 });
  const row = (await pool.query('SELECT followup_at, followup_error FROM invoices WHERE id = $1', [inv.id])).rows[0];
  assert.ok(row.followup_at);
  assert.equal(row.followup_error, 'WINDOW_CLOSED');
  sendImpl = null;
  await followup.processFollowups(new Date(NOW.getTime() + 3600 * 1000));
  assert.equal(sent.length, 1, 'solo el intento fallido');
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM messages WHERE direction = 'outbound'`)).rows[0].n, 0);
});
