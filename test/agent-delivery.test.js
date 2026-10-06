// Servicio de entregas (bot fase 2): cotizaciones y documentos aprobados salen en PDF por WhatsApp,
// una sola vez, con aviso a los admins cuando Meta cierra la ventana de 24 h o el envío falla.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-delivery-'));

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const delivery = require('../src/agent/delivery');
const { clearCache } = require('../src/agent/businessInfo');

const WINDOW_TEXT = 'pero WhatsApp no deja escribirle porque pasaron más de 24 h desde su último mensaje. '
  + 'Envíelo por otro medio, o espere a que el cliente escriba y pulse Enviar.';
const PHONE = '18095550001';
const DOCX = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('fake word content')]);
const PDF = Buffer.from('%PDF-1.4 fake');

let sent, sendImpl, conversions, convertImpl, adminId, actor, clientId;

delivery._setSender({
  sendDocument: async (to, filePath, fileName, caption) => {
    sent.push({ to, filePath, fileName, caption, bytes: fs.readFileSync(filePath) });
    return sendImpl ? sendImpl(sent.length) : { key: { id: `wa-${sent.length}` } };
  },
});
delivery._setConverter(async (input, target) => {
  conversions++;
  if (convertImpl) return convertImpl(input, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, PDF);
  return target;
});

test.beforeEach(async () => {
  sent = [];
  sendImpl = null;
  conversions = 0;
  convertImpl = null;
  clearCache();
  await createAgentSchema();
  await pool.query(`ALTER TABLE invoices ADD COLUMN pdf_path TEXT, ADD COLUMN pdf_s3_key TEXT, ADD COLUMN pdf_storage_type TEXT,
    ADD COLUMN sent_at TIMESTAMPTZ, ADD COLUMN rejected_by INT, ADD COLUMN rejected_at TIMESTAMPTZ`);
  await pool.query(`CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL`);
  await pool.query('DROP TABLE IF EXISTS activity_log, portfolio_versions, portfolio_documents CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  await runSqlFile('migrations/20261006_bot_fase2.sql'); // idempotente
  adminId = await createUser('leandro', 'admin', 'Leandro');
  actor = { id: adminId, username: 'leandro', name: 'Leandro', role: 'admin' };
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ($1, 'Juan Pérez') RETURNING id`, [PHONE])).rows[0].id;
});
test.after(async () => { await pool.end(); });

function tmpFile(name, content) {
  const p = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, name);
  fs.writeFileSync(p, content);
  return p;
}

async function makeInvoice({ total = 1500, pdf = true, status = 'approved' } = {}) {
  const n = (await pool.query('SELECT COUNT(*)::int n FROM invoices')).rows[0].n + 1;
  const docNumber = `COT-2026-${String(n).padStart(3, '0')}`;
  const pdfPath = pdf ? tmpFile(`${docNumber}.pdf`, PDF) : null;
  const { rows } = await pool.query(
    `INSERT INTO invoices (doc_number, type, status, client_id, client_name, client_phone, items, subtotal, itbis, total, created_by, source, pdf_path)
     VALUES ($1, 'COTIZACIÓN', $2, $3, 'Juan Pérez', $4, '[]', $5, 0, $5, $6, 'bot', $7) RETURNING *`,
    [docNumber, status, clientId, PHONE, total, adminId, pdfPath]
  );
  return rows[0];
}

async function makeDoc({ title = 'Poder especial', approved = true, sendMode = null, invoiceId = null, mime = 'docx', sentAt = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_documents (client_id, title, created_by, invoice_id, send_mode, sent_at, prepared_by_bot)
     VALUES ($1, $2, $3, $4, $5, $6, true) RETURNING id`,
    [clientId, title, adminId, invoiceId, sendMode, sentAt]
  );
  const id = rows[0].id;
  const isPdf = mime === 'pdf';
  const file = tmpFile(`doc-${id}.${isPdf ? 'pdf' : 'docx'}`, isPdf ? PDF : DOCX);
  const v = await pool.query(
    `INSERT INTO portfolio_versions (document_id, version_number, file_path, file_name, mime_type, size_bytes, pdf_path, source, created_by)
     VALUES ($1, 1, $2, $3, $4, $5, $6, 'generated', $7) RETURNING id`,
    [id, file, path.basename(file), isPdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      isPdf ? PDF.length : DOCX.length, isPdf ? file : null, adminId]
  );
  if (approved) await pool.query('UPDATE portfolio_documents SET approved_version_id = $1 WHERE id = $2', [v.rows[0].id, id]);
  return { id, versionId: v.rows[0].id, file };
}

const invoiceRow = async (id) => (await pool.query('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
const docRow = async (id) => (await pool.query('SELECT * FROM portfolio_documents WHERE id = $1', [id])).rows[0];
const notices = async () => (await pool.query('SELECT * FROM notifications ORDER BY id')).rows;

test('migración: columnas, check de send_mode y switch de digitadores (idempotente)', async () => {
  const cols = async (t) => (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1`, [t])).rows.map((r) => r.column_name);
  const pd = await cols('portfolio_documents');
  for (const c of ['invoice_id', 'prepared_by_bot', 'send_mode', 'sent_at', 'send_error']) assert.ok(pd.includes(c), c);
  const inv = await cols('invoices');
  for (const c of ['sent_by_bot_at', 'send_error']) assert.ok(inv.includes(c), c);
  await assert.rejects(pool.query(`INSERT INTO portfolio_documents (client_id, title, send_mode) VALUES ($1, 'x', 'luego')`, [clientId]), /send_mode/);
  const sw = await pool.query(`SELECT valor FROM business_info WHERE clave = 'digitadores_aprueban_documentos'`);
  assert.equal(sw.rows[0].valor, false);
});

test('sendQuote envía el PDF con el total y las formas de pago, una sola vez aunque se llame dos veces a la vez', async () => {
  const inv = await makeInvoice({ total: 1500 });
  const results = await Promise.all([delivery.sendQuote(inv.id, { actor }), delivery.sendQuote(inv.id, { actor })]);
  assert.deepEqual(results.map((r) => r.ok).sort(), [false, true]);
  assert.equal(results.find((r) => !r.ok).code, 'ALREADY_SENT');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE);
  assert.equal(sent[0].fileName, `${inv.doc_number}.pdf`);
  assert.equal(sent[0].caption,
    `Le comparto su cotización ${inv.doc_number} por RD$ 1,500.00. Formas de pago: transferencia o efectivo. `
    + 'Estamos en Av. Independencia 1607, Santo Domingo. Cualquier duda me escribe. 🦉');
  const row = await invoiceRow(inv.id);
  assert.equal(row.status, 'sent');
  assert.ok(row.sent_at);
  assert.ok(row.sent_by_bot_at);
  assert.equal(row.send_error, null);

  // Una vez enviada, no vuelve a salir
  assert.deepEqual(await delivery.sendQuote(inv.id, { actor }), { ok: false, code: 'ALREADY_SENT' });
  assert.equal(sent.length, 1);
});

test('sendQuote genera el PDF si falta y lo guarda en la cotización', async () => {
  const inv = await makeInvoice({ pdf: false });
  let generated = 0;
  delivery._setInvoicePdf(async (row) => { generated++; return tmpFile(`gen-${row.doc_number}.pdf`, PDF); });
  try {
    assert.deepEqual(await delivery.sendQuote(inv.id, { actor }), { ok: true });
  } finally {
    delivery._setInvoicePdf(null);
  }
  assert.equal(generated, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].bytes.toString(), PDF.toString());
  assert.equal((await invoiceRow(inv.id)).pdf_path, sent[0].filePath);
});

test('sendDocument convierte a PDF y nunca envía el Word', async () => {
  const doc = await makeDoc({ title: 'Poder especial' });
  assert.deepEqual(await delivery.sendDocument(doc.id, { actor }), { ok: true });
  assert.equal(conversions, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE);
  assert.equal(sent[0].fileName, 'Poder especial.pdf');
  assert.ok(sent[0].filePath.endsWith('.pdf'));
  assert.notEqual(sent[0].filePath, doc.file);
  assert.equal(sent[0].bytes.toString(), PDF.toString()); // el PDF convertido, no el .docx
  assert.equal(sent[0].caption, 'Aquí tiene su documento «Poder especial». Gracias por confiar en Gurú. 🦉');
  const v = (await pool.query('SELECT pdf_path FROM portfolio_versions WHERE id = $1', [doc.versionId])).rows[0];
  assert.equal(v.pdf_path, sent[0].filePath);
  const row = await docRow(doc.id);
  assert.ok(row.sent_at);
  assert.equal(row.send_error, null);

  // Segunda vez: ya salió, no se repite ni se reconvierte
  assert.deepEqual(await delivery.sendDocument(doc.id, { actor }), { ok: false, code: 'ALREADY_SENT' });
  assert.equal(sent.length, 1);
  assert.equal(conversions, 1);
});

test('sendDocument reusa el pdf_path de la versión y no reconvierte', async () => {
  const doc = await makeDoc({ mime: 'pdf' });
  assert.deepEqual(await delivery.sendDocument(doc.id, { actor }), { ok: true });
  assert.equal(conversions, 0);
  assert.equal(sent[0].filePath, doc.file);
});

test('sendDocument sin versión aprobada no envía nada', async () => {
  const doc = await makeDoc({ approved: false });
  assert.deepEqual(await delivery.sendDocument(doc.id, { actor }), { ok: false, code: 'NOT_APPROVED' });
  assert.equal(sent.length, 0);
  assert.equal((await docRow(doc.id)).sent_at, null);
});

test('falla del PDF: no envía, send_error PDF_FAILED, sent_at sigue null, avisa', async () => {
  convertImpl = async () => { const e = new Error('soffice no está'); e.code = 'PDF_UNAVAILABLE'; throw e; };
  const doc = await makeDoc();
  assert.deepEqual(await delivery.sendDocument(doc.id, { actor }), { ok: false, code: 'PDF_FAILED' });
  assert.equal(sent.length, 0);
  const row = await docRow(doc.id);
  assert.equal(row.sent_at, null);
  assert.equal(row.send_error, 'PDF_FAILED');
  const n = await notices();
  assert.equal(n.length, 1);
  assert.equal(n[0].user_id, adminId);
  assert.equal(n[0].type, 'delivery');
  assert.match(n[0].message, /PDF/);
  assert.match(n[0].message, /Poder especial/);

  // La cotización también: el PDF falla → nada sale
  const inv = await makeInvoice({ pdf: false });
  delivery._setInvoicePdf(async () => { throw new Error('weasyprint exited with code 1'); });
  try {
    assert.deepEqual(await delivery.sendQuote(inv.id, { actor }), { ok: false, code: 'PDF_FAILED' });
  } finally {
    delivery._setInvoicePdf(null);
  }
  assert.equal(sent.length, 0);
  const ir = await invoiceRow(inv.id);
  assert.equal(ir.sent_by_bot_at, null);
  assert.equal(ir.status, 'approved');
  assert.equal(ir.send_error, 'PDF_FAILED');
});

test('WINDOW_CLOSED: no reintenta, guarda el error y avisa a los admins con el texto de las 24 h', async () => {
  const otherAdmin = await createUser('ana', 'admin', 'Ana');
  const digitador = await createUser('hengi', 'digitador', 'Hengi');
  sendImpl = () => { const e = new Error('Meta 131047'); e.code = 'WINDOW_CLOSED'; throw e; };

  const inv = await makeInvoice();
  assert.deepEqual(await delivery.sendQuote(inv.id, { actor }), { ok: false, code: 'WINDOW_CLOSED' });
  assert.equal(sent.length, 1); // sin reintento
  const ir = await invoiceRow(inv.id);
  assert.equal(ir.sent_by_bot_at, null);
  assert.equal(ir.sent_at, null);
  assert.equal(ir.status, 'approved');
  assert.equal(ir.send_error, 'WINDOW_CLOSED');

  const doc = await makeDoc({ title: 'Contrato de alquiler' });
  assert.deepEqual(await delivery.sendDocument(doc.id, { actor }), { ok: false, code: 'WINDOW_CLOSED' });
  assert.equal(sent.length, 2);
  const dr = await docRow(doc.id);
  assert.equal(dr.sent_at, null);
  assert.equal(dr.send_error, 'WINDOW_CLOSED');

  const n = await notices();
  assert.deepEqual(n.map((x) => x.user_id).sort(), [adminId, adminId, otherAdmin, otherAdmin].sort());
  assert.ok(!n.some((x) => x.user_id === digitador));
  assert.ok(n.every((x) => x.type === 'delivery'));
  const quoteNotice = n.find((x) => x.message.includes(inv.doc_number));
  assert.equal(quoteNotice.message, `La cotización ${inv.doc_number} de Juan Pérez está aprobada, ${WINDOW_TEXT.replace('Envíelo', 'Envíela')}`);
  const docNotice = n.find((x) => x.message.includes('Contrato de alquiler'));
  assert.equal(docNotice.message, `El documento «Contrato de alquiler» de Juan Pérez está aprobado, ${WINDOW_TEXT}`);
  assert.equal(docNotice.metadata.document_id, doc.id);
  assert.equal(quoteNotice.metadata.invoice_id, inv.id);

  // No queda nada registrado como enviado
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM messages')).rows[0].n, 0);

  // Cuando el cliente vuelve a escribir, el mismo botón lo envía
  sendImpl = null;
  assert.deepEqual(await delivery.sendQuote(inv.id, { actor }), { ok: true });
  assert.equal((await invoiceRow(inv.id)).send_error, null);
});

test('otro error: reintenta una vez y luego SEND_FAILED', async () => {
  // Primer intento falla, el segundo sale
  sendImpl = (n) => { if (n === 1) throw new Error('socket hang up'); };
  const inv = await makeInvoice();
  assert.deepEqual(await delivery.sendQuote(inv.id, { actor }), { ok: true });
  assert.equal(sent.length, 2);
  assert.equal((await invoiceRow(inv.id)).status, 'sent');
  assert.equal((await notices()).length, 0);

  // Los dos fallan → SEND_FAILED, se revierte y se avisa
  sent = [];
  sendImpl = () => { throw new Error('No active WhatsApp connection'); };
  const doc = await makeDoc();
  assert.deepEqual(await delivery.sendDocument(doc.id, { actor }), { ok: false, code: 'SEND_FAILED' });
  assert.equal(sent.length, 2);
  const dr = await docRow(doc.id);
  assert.equal(dr.sent_at, null);
  assert.equal(dr.send_error, 'SEND_FAILED');
  const n = await notices();
  assert.equal(n.length, 1);
  assert.equal(n[0].type, 'delivery');
  assert.match(n[0].message, /No se pudo enviar/);

  // Si el reintento devuelve WINDOW_CLOSED, manda ese código
  sent = [];
  sendImpl = (k) => { if (k === 1) throw new Error('timeout'); const e = new Error('Meta'); e.code = 'WINDOW_CLOSED'; throw e; };
  const inv2 = await makeInvoice();
  assert.deepEqual(await delivery.sendQuote(inv2.id, { actor }), { ok: false, code: 'WINDOW_CLOSED' });
  assert.equal((await invoiceRow(inv2.id)).send_error, 'WINDOW_CLOSED');
});

test('deliverPaidDocuments solo envía los aprobados con al_pagar y sin enviar', async () => {
  const inv = await makeInvoice();
  const other = await makeInvoice();
  const a = await makeDoc({ title: 'A al pagar', sendMode: 'al_pagar', invoiceId: inv.id });
  const b = await makeDoc({ title: 'B ya', sendMode: 'ya', invoiceId: inv.id });
  const c = await makeDoc({ title: 'C sin aprobar', sendMode: 'al_pagar', invoiceId: inv.id, approved: false });
  const d = await makeDoc({ title: 'D enviado', sendMode: 'al_pagar', invoiceId: inv.id, sentAt: new Date() });
  const e = await makeDoc({ title: 'E otra cotización', sendMode: 'al_pagar', invoiceId: other.id });
  const f = await makeDoc({ title: 'F manual', sendMode: 'manual', invoiceId: inv.id });

  assert.equal(await delivery.deliverPaidDocuments(inv.id, { actor }), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fileName, 'A al pagar.pdf');
  assert.ok((await docRow(a.id)).sent_at);
  for (const x of [b, c, e, f]) assert.equal((await docRow(x.id)).sent_at, null, x.id);
  assert.ok((await docRow(d.id)).sent_at);

  // Segunda confirmación: nada pendiente
  assert.equal(await delivery.deliverPaidDocuments(inv.id, { actor }), 0);
  assert.equal(sent.length, 1);

  // Si uno falla, los demás siguen y se cuenta solo lo enviado
  const g = await makeDoc({ title: 'G', sendMode: 'al_pagar', invoiceId: other.id });
  sendImpl = (n) => { if (sent[n - 1].fileName === 'E otra cotización.pdf') { const err = new Error('x'); err.code = 'WINDOW_CLOSED'; throw err; } };
  assert.equal(await delivery.deliverPaidDocuments(other.id, { actor }), 1);
  assert.equal((await docRow(e.id)).send_error, 'WINDOW_CLOSED');
  assert.ok((await docRow(g.id)).sent_at);
});

test('cada envío queda en messages y en activity_log', async () => {
  const inv = await makeInvoice({ total: 2500 });
  await pool.query(`INSERT INTO messages (phone, client_id, direction, content, wa_jid) VALUES ($1, $2, 'inbound', 'hola', '123@lid')`, [PHONE, clientId]);
  assert.deepEqual(await delivery.sendQuote(inv.id, { actor: { id: adminId, username: 'leandro', role: 'admin' } }), { ok: true });
  assert.equal(sent[0].to, '123@lid'); // el último JID conocido, como el envío manual del panel
  const doc = await makeDoc({ title: 'Poder' });
  assert.deepEqual(await delivery.sendDocument(doc.id, { actor }), { ok: true });

  const msgs = (await pool.query(`SELECT * FROM messages WHERE direction = 'outbound' ORDER BY id`)).rows;
  assert.equal(msgs.length, 2);
  for (const m of msgs) {
    assert.equal(m.phone, PHONE);
    assert.equal(m.client_id, clientId);
    assert.equal(m.read, true);
  }
  assert.equal(msgs[0].content, sent[0].caption);
  assert.equal(msgs[0].wa_message_id, 'wa-1');
  assert.equal(msgs[1].content, sent[1].caption);

  const log = (await pool.query('SELECT * FROM activity_log ORDER BY id')).rows;
  assert.equal(log.length, 2);
  assert.equal(log[0].category, 'facturas');
  assert.equal(log[0].action, 'invoice.send');
  assert.equal(log[0].entity_type, 'invoice');
  assert.equal(log[0].entity_id, String(inv.id));
  assert.equal(log[0].actor_id, adminId);
  assert.equal(log[0].actor_name, 'leandro');
  assert.match(log[0].summary, new RegExp(`Envió la cotización ${inv.doc_number} a Juan Pérez`));
  assert.match(log[0].summary, /RD\$ 2,500\.00/);
  assert.equal(log[0].details.doc_number, inv.doc_number);
  assert.equal(log[1].category, 'documentos');
  assert.equal(log[1].action, 'documento.send');
  assert.equal(log[1].entity_type, 'documento');
  assert.equal(log[1].entity_id, String(doc.id));
  assert.equal(log[1].actor_id, adminId);
  assert.match(log[1].summary, /Envió «Poder» a Juan Pérez por WhatsApp/);

  // Un envío fallido no queda como mensaje ni en Actividad
  sendImpl = () => { const e = new Error('x'); e.code = 'WINDOW_CLOSED'; throw e; };
  const doc2 = await makeDoc({ title: 'Otro' });
  await delivery.sendDocument(doc2.id, { actor });
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM messages WHERE direction = 'outbound'`)).rows[0].n, 2);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM activity_log')).rows[0].n, 2);
});
