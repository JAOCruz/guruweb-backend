// Ventana de 24 h asíncrona (bot fase 2, revisión final): Meta acepta el envío y después avisa por webhook
// con un status "failed" 131047/131026. Ese aviso revierte la marca de enviado de la cotización o del documento
// cuyo delivery_wa_id coincide, deja send_error = WINDOW_CLOSED, avisa a los admins y queda en Actividad.
process.env.WHATSAPP_ACCESS_TOKEN = 'EAAG-test-token';
process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333';
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-wa-status-'));

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const cloudHandler = require('../src/whatsapp/cloudHandler');

const WINDOW_TEXT = 'pero WhatsApp no deja escribirle porque pasaron más de 24 h desde su último mensaje. '
  + 'Envíelo por otro medio, o espere a que el cliente escriba y pulse Enviar.';
const PHONE = '18095550001';
let adminId, clientId, logged;

const origError = console.error;
test.before(() => {
  console.error = (...args) => { logged.push(args.map(String).join(' ')); };
});
test.after(async () => { console.error = origError; await pool.end(); });

test.beforeEach(async () => {
  logged = [];
  await createAgentSchema();
  await pool.query(`ALTER TABLE invoices ADD COLUMN pdf_path TEXT, ADD COLUMN pdf_s3_key TEXT, ADD COLUMN pdf_storage_type TEXT,
    ADD COLUMN sent_at TIMESTAMPTZ, ADD COLUMN rejected_by INT, ADD COLUMN rejected_at TIMESTAMPTZ`);
  await pool.query('DROP TABLE IF EXISTS activity_log, portfolio_versions, portfolio_documents CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  await runSqlFile('migrations/20261007_delivery_wa_id.sql');
  adminId = await createUser('leandro', 'admin', 'Leandro');
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Juan Pérez') RETURNING id`, [PHONE])).rows[0].id;
});

async function sentInvoice({ status = 'sent', waId, docNumber }) {
  const { rows } = await pool.query(
    `INSERT INTO invoices (doc_number, type, status, client_id, client_name, client_phone, items, subtotal, itbis, total, created_by, source,
       sent_at, sent_by_bot_at, delivery_wa_id)
     VALUES ($1, 'COTIZACIÓN', $2, $3, 'Juan Pérez', $4, '[]', 1500, 0, 1500, $5, 'bot', NOW(), NOW(), $6) RETURNING *`,
    [docNumber, status, clientId, PHONE, adminId, waId]);
  return rows[0];
}

async function sentDoc({ title, waId }) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_documents (client_id, title, created_by, send_mode, sent_at, delivery_wa_id, prepared_by_bot)
     VALUES ($1, $2, $3, 'ya', NOW(), $4, true) RETURNING id`, [clientId, title, adminId, waId]);
  const { rows: v } = await pool.query(
    `INSERT INTO portfolio_versions (document_id, version_number, file_path, file_name, mime_type, size_bytes, source, created_by)
     VALUES ($1, 1, '/x.pdf', 'x.pdf', 'application/pdf', 1, 'generated', $2) RETURNING id`, [rows[0].id, adminId]);
  await pool.query('UPDATE portfolio_documents SET approved_version_id = $1 WHERE id = $2', [v[0].id, rows[0].id]);
  return rows[0].id;
}

const failed = (id, code, title = 'Re-engagement message') => ({ id, status: 'failed', timestamp: '1759760000', recipient_id: PHONE, errors: [{ code, title }] });
const payload = (statuses) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: '1809', phone_number_id: '111222333' }, statuses } }] }],
});

const invoiceRow = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
const docRow = async (id) => (await pool.query('SELECT * FROM portfolio_documents WHERE id = $1', [id])).rows[0];
const notices = async () => (await pool.query('SELECT * FROM notifications ORDER BY id')).rows;

test('un status failed 131047/131026 revierte el envío de la cotización y del documento, avisa y registra; sin teléfono en el log', async () => {
  const otherAdmin = await createUser('ana', 'admin', 'Ana');
  const cot = await sentInvoice({ waId: 'wamid.COT1', docNumber: 'COT-2026-001' });
  const paid = await sentInvoice({ status: 'paid', waId: 'wamid.COT2', docNumber: 'COT-2026-002' });
  const untouched = await sentInvoice({ waId: 'wamid.COT3', docNumber: 'COT-2026-003' });
  const doc = await sentDoc({ title: 'Contrato de alquiler', waId: 'wamid.DOC1' });
  const docOk = await sentDoc({ title: 'Poder', waId: 'wamid.DOC2' });
  await pool.query(`INSERT INTO messages (wa_message_id, phone, client_id, direction, content, status) VALUES ('wamid.COT1', $1, $2, 'outbound', 'Le comparto su cotización', 'sent')`, [PHONE, clientId]);

  await cloudHandler.processWebhookPayload(payload([
    failed('wamid.COT1', 131047),
    failed('wamid.COT2', 131026, 'Message undeliverable'),
    failed('wamid.DOC1', 131047),
    failed('wamid.DOC2', 130472, 'User\'s number is part of an experiment'), // otro error: no es la ventana
    { id: 'wamid.COT3', status: 'delivered', timestamp: '1759760000', recipient_id: PHONE },
    failed('wamid.NADIE', 131047), // id que no es de ninguna entrega
  ]));

  // Cotización enviada → vuelve a aprobada, lista para reenviar cuando el cliente escriba
  const c = await invoiceRow(cot.id);
  assert.equal(c.status, 'approved');
  assert.equal(c.sent_at, null);
  assert.equal(c.sent_by_bot_at, null);
  assert.equal(c.send_error, 'WINDOW_CLOSED');
  assert.equal(c.delivery_wa_id, null);
  // Pagada: sigue pagada, pero sin la marca de enviada
  const p = await invoiceRow(paid.id);
  assert.equal(p.status, 'paid');
  assert.equal(p.sent_by_bot_at, null);
  assert.equal(p.send_error, 'SEND_FAILED'); // 131026 es "no entregable" genérico, no la ventana de 24 h
  // Entregada: intacta
  const u = await invoiceRow(untouched.id);
  assert.equal(u.status, 'sent');
  assert.ok(u.sent_by_bot_at);
  assert.equal(u.send_error, null);
  assert.equal(u.delivery_wa_id, 'wamid.COT3');
  // Documento
  const d = await docRow(doc);
  assert.equal(d.sent_at, null);
  assert.equal(d.send_error, 'WINDOW_CLOSED');
  assert.equal(d.delivery_wa_id, null);
  assert.ok(d.approved_version_id); // la aprobación queda
  const ok = await docRow(docOk);
  assert.ok(ok.sent_at);
  assert.equal(ok.send_error, null);

  // El mensaje registrado queda como fallido
  assert.equal((await pool.query(`SELECT status FROM messages WHERE wa_message_id = 'wamid.COT1'`)).rows[0].status, 'failed');

  // Avisos a los admins con el texto de la spec §4 (uno por entrega y por admin)
  const n = await notices();
  assert.equal(n.length, 6);
  assert.ok(n.every((x) => x.type === 'delivery'));
  assert.deepEqual([...new Set(n.map((x) => x.user_id))].sort(), [adminId, otherAdmin].sort());
  const cotN = n.find((x) => x.metadata.invoice_id === cot.id);
  assert.equal(cotN.message, `La cotización COT-2026-001 de Juan Pérez está aprobada, ${WINDOW_TEXT.replace('Envíelo', 'Envíela')}`);
  assert.equal(cotN.metadata.code, 'WINDOW_CLOSED');
  assert.equal(cotN.link, '/cotizaciones');
  const docN = n.find((x) => x.metadata.document_id === doc);
  assert.equal(docN.message, `El documento «Contrato de alquiler» de Juan Pérez está aprobado, ${WINDOW_TEXT}`);
  assert.equal(docN.link, '/documentos');
  const paidN = n.find((x) => x.metadata.invoice_id === paid.id);
  assert.equal(paidN.message, 'No se pudo entregar por WhatsApp la cotización COT-2026-002 de Juan Pérez; revise el número o envíelo por otro medio.');
  assert.equal(paidN.metadata.code, 'SEND_FAILED');
  assert.ok(!/24 h/.test(paidN.message));

  // Actividad
  const log = (await pool.query('SELECT * FROM activity_log ORDER BY id')).rows;
  assert.equal(log.length, 3);
  const cotLog = log.find((l) => l.entity_type === 'invoice' && l.entity_id === String(cot.id));
  assert.equal(cotLog.action, 'invoice.send_failed');
  assert.match(cotLog.summary, /COT-2026-001.*24 h/);
  assert.equal(cotLog.details.code, 'WINDOW_CLOSED');
  const docLog = log.find((l) => l.entity_type === 'documento');
  assert.equal(docLog.action, 'documento.send_failed');
  assert.equal(docLog.entity_id, String(doc));

  // En consola: ids y códigos, nunca el teléfono
  assert.ok(logged.length >= 1);
  assert.ok(!logged.some((l) => l.includes(PHONE)), logged.join('\n'));
  assert.ok(logged.some((l) => /131047/.test(l)));

  // Meta reintenta el webhook: nada cambia ni se avisa dos veces
  await cloudHandler.processWebhookPayload(payload([failed('wamid.COT1', 131047), failed('wamid.DOC1', 131047)]));
  assert.equal((await notices()).length, 6);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM activity_log')).rows[0].n, 3);
});

test('el aviso de otro número de teléfono se ignora', async () => {
  const cot = await sentInvoice({ waId: 'wamid.COT1', docNumber: 'COT-2026-001' });
  const p = payload([failed('wamid.COT1', 131047)]);
  p.entry[0].changes[0].value.metadata.phone_number_id = '999';
  await cloudHandler.processWebhookPayload(p);
  assert.equal((await invoiceRow(cot.id)).status, 'sent');
  assert.equal((await notices()).length, 0);
});

test('el documento trae invoice_status de su cotización ligada (null sin cotización)', async () => {
  const portfolio = require('../src/documentos/portfolio');
  const paid = await sentInvoice({ status: 'paid', waId: 'wamid.P', docNumber: 'COT-2026-010' });
  const linked = await sentDoc({ title: 'Con cotización', waId: 'wamid.D1' });
  const free = await sentDoc({ title: 'Sin cotización', waId: 'wamid.D2' });
  await pool.query('UPDATE portfolio_documents SET invoice_id = $1 WHERE id = $2', [paid.id, linked]);
  const admin = { id: adminId, role: 'admin' };
  assert.equal((await portfolio.getDocument(admin, linked)).invoice_status, 'paid');
  assert.equal((await portfolio.getDocument(admin, free)).invoice_status, null);
  const list = await portfolio.listDocuments(admin, { clientId });
  assert.equal(list.find((d) => d.id === linked).invoice_status, 'paid');
});
