// Cotizaciones (bot fase 2): "Aprobar y enviar" y entrega de documentos al confirmar el pago.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-appsend-'));

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const delivery = require('../src/agent/delivery');
const { clearCache } = require('../src/agent/businessInfo');
const { generateToken } = require('../src/middleware/auth');

const PHONE = '18095550001';
const PDF = Buffer.from('%PDF-1.4 fake');
const DOCX = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('fake word content')]);

let sent, sendImpl, server, base, adminId, digitadorId, clientId, tok;

delivery._setSender({
  sendDocument: async (to, filePath, fileName, caption) => {
    sent.push({ to, fileName, caption });
    await new Promise((r) => setTimeout(r, 20)); // da tiempo a que el otro clic llegue
    return sendImpl ? sendImpl(sent.length) : { key: { id: `wa-${sent.length}` } };
  },
});
delivery._setConverter(async (input, target) => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, PDF);
  return target;
});

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/invoices', require('../src/routes/invoices'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  sent = [];
  sendImpl = null;
  clearCache();
  await createAgentSchema();
  await pool.query(`ALTER TABLE invoices ADD COLUMN pdf_path TEXT, ADD COLUMN pdf_s3_key TEXT, ADD COLUMN pdf_storage_type TEXT,
    ADD COLUMN sent_at TIMESTAMPTZ, ADD COLUMN rejected_by INT, ADD COLUMN rejected_at TIMESTAMPTZ,
    ADD COLUMN paid_by INT, ADD COLUMN paid_at TIMESTAMPTZ, ADD COLUMN payment_method TEXT, ADD COLUMN payment_reference TEXT`);
  await pool.query(`CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL`);
  await pool.query('DROP TABLE IF EXISTS activity_log, portfolio_versions, portfolio_documents CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  adminId = await createUser('leandro', 'admin', 'Leandro');
  digitadorId = await createUser('hengi', 'digitador', 'Hengi');
  tok = {
    admin: generateToken({ id: adminId, username: 'leandro', email: 'leandro@t.co', role: 'admin' }),
    hengi: generateToken({ id: digitadorId, username: 'hengi', email: 'hengi@t.co', role: 'digitador' }),
  };
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Juan Pérez') RETURNING id`, [PHONE])).rows[0].id;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (p, who) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: '{}' });
const invoiceRow = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];

async function makeInvoice(status = 'pending_approval') {
  const n = (await pool.query('SELECT COUNT(*)::int n FROM invoices')).rows[0].n + 1;
  const docNumber = `COT-2026-${String(n).padStart(3, '0')}`;
  const file = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, `${docNumber}.pdf`);
  fs.writeFileSync(file, PDF);
  const { rows } = await pool.query(
    `INSERT INTO invoices (doc_number, type, status, client_id, client_name, client_phone, items, subtotal, itbis, total, created_by, source, pdf_path)
     VALUES ($1, 'COTIZACIÓN', $2, $3, 'Juan Pérez', $4, '[]', 1500, 0, 1500, $5, 'bot', $6) RETURNING *`,
    [docNumber, status, clientId, PHONE, adminId, file]);
  return rows[0];
}

async function makeDoc(invoiceId, title = 'Poder especial') {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_documents (client_id, title, created_by, invoice_id, send_mode, prepared_by_bot)
     VALUES ($1, $2, $3, $4, 'al_pagar', true) RETURNING id`, [clientId, title, adminId, invoiceId]);
  const id = rows[0].id;
  const file = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, `doc-${id}.docx`);
  fs.writeFileSync(file, DOCX);
  const v = await pool.query(
    `INSERT INTO portfolio_versions (document_id, version_number, file_path, file_name, mime_type, size_bytes, source, created_by)
     VALUES ($1, 1, $2, $3, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', $4, 'generated', $5) RETURNING id`,
    [id, file, path.basename(file), DOCX.length, adminId]);
  await pool.query('UPDATE portfolio_documents SET approved_version_id = $1 WHERE id = $2', [v.rows[0].id, id]);
  return id;
}

test('aprobar y enviar: queda approved y luego sent, y se envía 1 vez', async () => {
  const inv = await makeInvoice('pending_approval');
  const res = await call(`/api/invoices/${inv.id}/approve-and-send`, 'admin');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent, true);
  assert.equal(body.code, undefined);
  assert.equal(body.invoice.status, 'sent');
  assert.equal(body.invoice.approved_by, adminId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE);
  const log = await pool.query(`SELECT summary FROM activity_log WHERE action = 'invoice.approve_send'`);
  assert.equal(log.rows.length, 1);
  assert.match(log.rows[0].summary, /^Aprobó y envió por WhatsApp/);

  // Ya enviada: 200 con sent:false
  const again = await call(`/api/invoices/${inv.id}/approve-and-send`, 'admin');
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json().then((b) => ({ sent: b.sent, code: b.code })), { sent: false, code: 'ALREADY_SENT' });
  assert.equal(sent.length, 1);
});

test('ya aprobada: solo envía; rechazada: 400 y no sale nada', async () => {
  const approved = await makeInvoice('approved');
  const body = await (await call(`/api/invoices/${approved.id}/approve-and-send`, 'admin')).json();
  assert.equal(body.sent, true);
  assert.equal(sent.length, 1);

  const rejected = await makeInvoice('rejected');
  assert.equal((await call(`/api/invoices/${rejected.id}/approve-and-send`, 'admin')).status, 400);
  assert.equal((await call('/api/invoices/99999/approve-and-send', 'admin')).status, 404);
  assert.equal(sent.length, 1);
});

test('doble clic simultáneo: un solo envío', async () => {
  const inv = await makeInvoice('pending_approval');
  const rs = await Promise.all([call(`/api/invoices/${inv.id}/approve-and-send`, 'admin'), call(`/api/invoices/${inv.id}/approve-and-send`, 'admin')]);
  assert.deepEqual(rs.map((r) => r.status), [200, 200]);
  const bodies = await Promise.all(rs.map((r) => r.json()));
  assert.deepEqual(bodies.map((b) => b.sent).sort(), [false, true]);
  assert.equal(bodies.find((b) => !b.sent).code, 'ALREADY_SENT');
  assert.equal(sent.length, 1);
  assert.equal((await invoiceRow(inv.id)).status, 'sent');
});

test('un digitador recibe 403', async () => {
  const inv = await makeInvoice('pending_approval');
  const res = await call(`/api/invoices/${inv.id}/approve-and-send`, 'hengi');
  assert.equal(res.status, 403);
  assert.equal(sent.length, 0);
  assert.equal((await invoiceRow(inv.id)).status, 'pending_approval');
});

test('confirmar el pago envía los documentos al_pagar ya aprobados', async () => {
  const inv = await makeInvoice('sent');
  await makeDoc(inv.id);
  const res = await call(`/api/invoices/${inv.id}/confirm-payment`, 'admin');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.documents_sent, 1);
  assert.equal(body.invoice.status, 'paid');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fileName, 'Poder especial.pdf');
});

test('si el envío falla por 24 h, el pago sigue confirmado y la respuesta lo dice', async () => {
  const inv = await makeInvoice('sent');
  await makeDoc(inv.id);
  sendImpl = () => { const e = new Error('Meta 131047'); e.code = 'WINDOW_CLOSED'; throw e; };
  const res = await call(`/api/invoices/${inv.id}/confirm-payment`, 'admin');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.documents_sent, 0);
  assert.equal(body.invoice.status, 'paid');
  assert.equal((await invoiceRow(inv.id)).status, 'paid');

  // Si deliverPaidDocuments lanza, el pago tampoco se anula
  const inv2 = await makeInvoice('sent');
  const orig = delivery.deliverPaidDocuments;
  delivery.deliverPaidDocuments = async () => { throw new Error('boom'); };
  try {
    const r2 = await call(`/api/invoices/${inv2.id}/confirm-payment`, 'admin');
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).documents_sent, 0);
    assert.equal((await invoiceRow(inv2.id)).status, 'paid');
  } finally {
    delivery.deliverPaidDocuments = orig;
  }
});
