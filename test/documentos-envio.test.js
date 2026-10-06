// Documentos (bot fase 2): aprobar con modo de envío, "Enviar al cliente" y el switch que deja a los
// digitadores aprobar y enviar los documentos del bot de sus clientes asignados.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-docsend-'));

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const delivery = require('../src/agent/delivery');
const { clearCache } = require('../src/agent/businessInfo');
const { generateToken } = require('../src/middleware/auth');

const PHONE = '18095550001';
const PDF = Buffer.from('%PDF-1.4 fake');
const DOCX = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('fake word content')]);

let sent, sendImpl, server, base, ids, clientId, otherClientId, tok;

delivery._setSender({
  sendDocument: async (to, filePath, fileName, caption) => {
    sent.push({ to, fileName, caption });
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
  app.use('/api/documentos', require('../src/routes/documentos'));
  app.use('/api/settings', require('../src/routes/settings'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  sent = [];
  sendImpl = null;
  clearCache();
  await createAgentSchema();
  await pool.query(`ALTER TABLE invoices ADD COLUMN pdf_path TEXT, ADD COLUMN pdf_s3_key TEXT, ADD COLUMN pdf_storage_type TEXT,
    ADD COLUMN sent_at TIMESTAMPTZ, ADD COLUMN rejected_by INT, ADD COLUMN rejected_at TIMESTAMPTZ`);
  await pool.query(`CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL`);
  await pool.query('DROP TABLE IF EXISTS activity_log, portfolio_versions, portfolio_documents CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  await runSqlFile('migrations/20261007_delivery_wa_id.sql');
  ids = {
    admin: await createUser('leandro', 'admin', 'Leandro'),
    hengi: await createUser('hengi', 'digitador', 'Hengi'),
    marleni: await createUser('marleni', 'digitador', 'Marleni'),
  };
  tok = {};
  for (const [who, id] of Object.entries(ids)) {
    tok[who] = generateToken({ id, username: who === 'admin' ? 'leandro' : who, email: `${who}@t.co`, role: who === 'admin' ? 'admin' : 'digitador' });
  }
  // Juan está asignado a Hengi; María no está asignada a nadie
  clientId = (await pool.query(`INSERT INTO clients (phone, name, assigned_to) VALUES ($1, 'Juan Pérez', $2) RETURNING id`, [PHONE, ids.hengi])).rows[0].id;
  otherClientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ('18095550002', 'María Gómez') RETURNING id`)).rows[0].id;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, p, who, body) =>
  fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });
const docRow = async (id) => (await pool.query('SELECT * FROM portfolio_documents WHERE id = $1', [id])).rows[0];
const setSwitch = (on) => call('PUT', '/api/settings/bot', 'admin', { digitadores_aprueban_documentos: on });

async function makeInvoice(status = 'approved') {
  const n = (await pool.query('SELECT COUNT(*)::int n FROM invoices')).rows[0].n + 1;
  const docNumber = `COT-2026-${String(n).padStart(3, '0')}`;
  const file = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, `${docNumber}.pdf`);
  fs.writeFileSync(file, PDF);
  const { rows } = await pool.query(
    `INSERT INTO invoices (doc_number, type, status, client_id, client_name, client_phone, items, subtotal, itbis, total, created_by, source, pdf_path)
     VALUES ($1, 'COTIZACIÓN', $2, $3, 'Juan Pérez', $4, '[]', 1500, 0, 1500, $5, 'bot', $6) RETURNING *`,
    [docNumber, status, clientId, PHONE, ids.admin, file]);
  return rows[0];
}

// Borrador del bot (prepared_by_bot) salvo que se diga lo contrario; sin versión aprobada.
async function makeDoc({ title = 'Poder especial', invoiceId = null, createdBy = ids.admin, bot = true, client = clientId, approved = false } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO portfolio_documents (client_id, title, created_by, invoice_id, prepared_by_bot) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [client, title, createdBy, invoiceId, bot]);
  const id = rows[0].id;
  const file = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, `doc-${id}.docx`);
  fs.writeFileSync(file, DOCX);
  const v = await pool.query(
    `INSERT INTO portfolio_versions (document_id, version_number, file_path, file_name, mime_type, size_bytes, source, created_by)
     VALUES ($1, 1, $2, $3, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', $4, 'generated', $5) RETURNING id`,
    [id, file, path.basename(file), DOCX.length, createdBy]);
  if (approved) await pool.query('UPDATE portfolio_documents SET approved_version_id = $1 WHERE id = $2', [v.rows[0].id, id]);
  return { id, versionId: v.rows[0].id };
}

test('aprobar con al_pagar no envía si la cotización no está pagada', async () => {
  const inv = await makeInvoice('sent');
  const doc = await makeDoc({ invoiceId: inv.id });
  const res = await call('POST', `/api/documentos/documents/${doc.id}/approve`, 'admin', { version_id: doc.versionId, send_mode: 'al_pagar' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent, false);
  assert.equal(body.code, undefined);
  assert.equal(body.document.send_mode, 'al_pagar');
  assert.equal(body.document.invoice_id, inv.id);
  assert.equal(body.document.prepared_by_bot, true);
  assert.equal(body.document.sent_at, null);
  assert.equal(body.document.send_error, null);
  assert.equal(body.document.can_approve, true);
  assert.equal(body.document.versions[0].status, 'approved');
  assert.equal(sent.length, 0);
  assert.equal((await docRow(doc.id)).sent_at, null);
  const log = (await pool.query(`SELECT summary FROM activity_log WHERE action = 'documento.approve'`)).rows;
  assert.equal(log.length, 1);
  assert.match(log[0].summary, /Aprobó la versión v1 de «Poder especial» \(Juan Pérez\)$/);

  // Por defecto: al_pagar si hay cotización, manual si no
  const d2 = await makeDoc({ invoiceId: inv.id });
  assert.equal((await (await call('POST', `/api/documentos/documents/${d2.id}/approve`, 'admin', { version_id: d2.versionId })).json()).document.send_mode, 'al_pagar');
  const d3 = await makeDoc();
  assert.equal((await (await call('POST', `/api/documentos/documents/${d3.id}/approve`, 'admin', { version_id: d3.versionId })).json()).document.send_mode, 'manual');
  assert.equal(sent.length, 0);

  // Un modo inventado no pasa, y no se aprueba nada
  const d4 = await makeDoc();
  const bad = await call('POST', `/api/documentos/documents/${d4.id}/approve`, 'admin', { version_id: d4.versionId, send_mode: 'luego' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'INVALID_SEND_MODE');
  assert.equal((await docRow(d4.id)).approved_version_id, null);
});

test('aprobar con al_pagar cuando ya está pagada envía al momento', async () => {
  const inv = await makeInvoice('paid');
  const doc = await makeDoc({ invoiceId: inv.id });
  const res = await call('POST', `/api/documentos/documents/${doc.id}/approve`, 'admin', { version_id: doc.versionId, send_mode: 'al_pagar' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sent, true);
  assert.equal(body.code, undefined);
  assert.ok(body.document.sent_at);
  assert.equal(body.document.send_mode, 'al_pagar');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE);
  assert.equal(sent[0].fileName, 'Poder especial.pdf');
  const log = (await pool.query(`SELECT summary FROM activity_log WHERE action = 'documento.approve'`)).rows;
  assert.equal(log.length, 1);
  assert.match(log[0].summary, /Aprobó la versión v1 de «Poder especial» \(Juan Pérez\) y lo envió por WhatsApp$/);
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM activity_log WHERE action = 'documento.send'`)).rows[0].n, 1);
});

test('aprobar con ya envía; con manual no envía', async () => {
  const a = await makeDoc({ title: 'Contrato' });
  let body = await (await call('POST', `/api/documentos/documents/${a.id}/approve`, 'admin', { version_id: a.versionId, send_mode: 'ya' })).json();
  assert.equal(body.sent, true);
  assert.equal(body.document.send_mode, 'ya');
  assert.ok(body.document.sent_at);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].fileName, 'Contrato.pdf');

  const inv = await makeInvoice('paid');
  const b = await makeDoc({ title: 'Poder', invoiceId: inv.id });
  body = await (await call('POST', `/api/documentos/documents/${b.id}/approve`, 'admin', { version_id: b.versionId, send_mode: 'manual' })).json();
  assert.equal(body.sent, false);
  assert.equal(body.code, undefined);
  assert.equal(body.document.send_mode, 'manual');
  assert.equal(body.document.sent_at, null);
  assert.equal(sent.length, 1); // aunque la cotización esté pagada, manual no sale solo
});

test('switch apagado: un digitador recibe 403', async () => {
  const res = await call('GET', '/api/settings/bot', 'hengi');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { digitadores_aprueban_documentos: false });

  // Un documento suyo: lo ve, pero no lo aprueba ni lo envía
  const mine = await makeDoc({ createdBy: ids.hengi, bot: false });
  assert.equal((await call('GET', `/api/documentos/documents/${mine.id}`, 'hengi')).status, 200);
  assert.equal((await (await call('GET', `/api/documentos/documents/${mine.id}`, 'hengi')).json()).document.can_approve, false);
  let r = await call('POST', `/api/documentos/documents/${mine.id}/approve`, 'hengi', { version_id: mine.versionId, send_mode: 'ya' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'FORBIDDEN');
  r = await call('POST', `/api/documentos/documents/${mine.id}/send`, 'hengi');
  assert.equal(r.status, 403);
  assert.equal((await docRow(mine.id)).approved_version_id, null);
  assert.equal(sent.length, 0);

  // El borrador del bot de su cliente ni lo ve
  const bot = await makeDoc();
  assert.equal((await call('GET', `/api/documentos/documents/${bot.id}`, 'hengi')).status, 404);
  assert.equal((await call('POST', `/api/documentos/documents/${bot.id}/approve`, 'hengi', { version_id: bot.versionId })).status, 404);
  const list = (await (await call('GET', '/api/documentos/documents', 'hengi')).json()).documents;
  assert.deepEqual(list.map((d) => d.id), [mine.id]);
});

test('switch encendido: el digitador asignado aprueba; otro digitador recibe 403', async () => {
  assert.equal((await setSwitch(true)).status, 200);
  // Borrador del bot para Juan (asignado a Hengi), creado por Marleni: ella lo ve, pero no lo aprueba
  const doc = await makeDoc({ createdBy: ids.marleni });
  let r = await call('GET', `/api/documentos/documents/${doc.id}`, 'marleni');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).document.can_approve, false);
  r = await call('POST', `/api/documentos/documents/${doc.id}/approve`, 'marleni', { version_id: doc.versionId, send_mode: 'ya' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'FORBIDDEN');
  assert.equal(sent.length, 0);

  r = await call('GET', `/api/documentos/documents/${doc.id}`, 'hengi');
  assert.equal(r.status, 200);
  assert.equal((await r.json()).document.can_approve, true);
  r = await call('POST', `/api/documentos/documents/${doc.id}/approve`, 'hengi', { version_id: doc.versionId, send_mode: 'ya' });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.sent, true);
  assert.equal(body.document.versions[0].status, 'approved');
  assert.equal(sent.length, 1);
  const row = await docRow(doc.id);
  assert.equal(row.approved_version_id, doc.versionId);
  assert.ok(row.sent_at);
  assert.equal((await pool.query('SELECT approved_by FROM portfolio_versions WHERE id = $1', [doc.versionId])).rows[0].approved_by, ids.hengi);
  const log = (await pool.query(`SELECT actor_id, summary FROM activity_log WHERE action = 'documento.approve'`)).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].actor_id, ids.hengi);
  assert.match(log[0].summary, /y lo envió por WhatsApp$/);

  // Un cliente que no es suyo: no lo aprueba aunque el switch esté encendido
  const other = await makeDoc({ client: otherClientId, createdBy: ids.hengi });
  r = await call('POST', `/api/documentos/documents/${other.id}/approve`, 'hengi', { version_id: other.versionId });
  assert.equal(r.status, 403);

  // Al apagar el switch, Hengi vuelve a recibir 403 en el acto (sin esperar la caché)
  assert.equal((await setSwitch(false)).status, 200);
  const again = await makeDoc({ createdBy: ids.hengi });
  r = await call('POST', `/api/documentos/documents/${again.id}/approve`, 'hengi', { version_id: again.versionId });
  assert.equal(r.status, 403);
});

test('switch encendido: el digitador asignado ve el borrador del bot de su cliente', async () => {
  const bot = await makeDoc({ title: 'Borrador del bot' });                       // Juan, creado por el admin
  const manual = await makeDoc({ title: 'Subido por el admin', bot: false });     // Juan, pero no es del bot
  const otherBot = await makeDoc({ title: 'Bot de María', client: otherClientId }); // bot, pero María no es de Hengi
  const mine = await makeDoc({ title: 'Mío', createdBy: ids.hengi, bot: false });

  let list = (await (await call('GET', '/api/documentos/documents', 'hengi')).json()).documents;
  assert.deepEqual(list.map((d) => d.id).sort(), [mine.id]);

  await setSwitch(true);
  list = (await (await call('GET', '/api/documentos/documents', 'hengi')).json()).documents;
  assert.deepEqual(list.map((d) => d.id).sort(), [bot.id, mine.id].sort());
  const row = list.find((d) => d.id === bot.id);
  assert.equal(row.prepared_by_bot, true);
  assert.equal(row.send_mode, null);
  assert.equal(row.sent_at, null);

  // Lo abre, con sus versiones y el archivo
  const res = await call('GET', `/api/documentos/documents/${bot.id}`, 'hengi');
  assert.equal(res.status, 200);
  const { document } = await res.json();
  assert.equal(document.can_approve, true);
  assert.equal(document.versions.length, 1);
  assert.equal((await call('GET', `/api/documentos/versions/${bot.versionId}/file`, 'hengi')).status, 200);
  // Pero no los que no son de sus clientes ni los que no preparó el bot
  for (const d of [manual, otherBot]) {
    assert.equal((await call('GET', `/api/documentos/documents/${d.id}`, 'hengi')).status, 404, d.title);
    assert.equal((await call('GET', `/api/documentos/versions/${d.versionId}/file`, 'hengi')).status, 404, d.title);
  }
  // Marleni (no asignada) sigue sin ver nada de esto
  list = (await (await call('GET', '/api/documentos/documents', 'marleni')).json()).documents;
  assert.deepEqual(list, []);
  assert.equal((await call('GET', `/api/documentos/versions/${bot.versionId}/file`, 'marleni')).status, 404);
  // El cliente aparece en su lista de clientes del historial
  const clients = (await (await call('GET', '/api/documentos/clients', 'hengi')).json()).clients;
  assert.deepEqual(clients.map((c) => c.id), [clientId]);
  // El admin sigue viendo todo
  list = (await (await call('GET', '/api/documentos/documents', 'admin')).json()).documents;
  assert.equal(list.length, 4);
});

test('enviar al cliente reenvía tras WINDOW_CLOSED', async () => {
  sendImpl = () => { const e = new Error('Meta 131047'); e.code = 'WINDOW_CLOSED'; throw e; };
  const doc = await makeDoc({ title: 'Contrato de alquiler' });
  let res = await call('POST', `/api/documentos/documents/${doc.id}/approve`, 'admin', { version_id: doc.versionId, send_mode: 'ya' });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.sent, false);
  assert.equal(body.code, 'WINDOW_CLOSED');
  assert.equal(body.document.send_error, 'WINDOW_CLOSED');
  assert.equal(body.document.sent_at, null);
  assert.equal(body.document.versions[0].status, 'approved'); // la aprobación queda aunque el envío falle
  assert.equal(sent.length, 1);
  const log = (await pool.query(`SELECT summary FROM activity_log WHERE action = 'documento.approve'`)).rows;
  assert.doesNotMatch(log[0].summary, /envió/);

  // El cliente volvió a escribir: "Enviar al cliente"
  sendImpl = null;
  res = await call('POST', `/api/documentos/documents/${doc.id}/send`, 'admin');
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.sent, true);
  assert.equal(body.code, undefined);
  assert.ok(body.document.sent_at);
  assert.equal(body.document.send_error, null);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].fileName, 'Contrato de alquiler.pdf');

  // Otra vez: ya salió
  res = await call('POST', `/api/documentos/documents/${doc.id}/send`, 'admin');
  assert.equal(res.status, 200);
  body = await res.json();
  assert.deepEqual({ sent: body.sent, code: body.code }, { sent: false, code: 'ALREADY_SENT' });
  assert.equal(sent.length, 2);

  // Sin versión aprobada no hay nada que enviar
  const draft = await makeDoc();
  res = await call('POST', `/api/documentos/documents/${draft.id}/send`, 'admin');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'NOT_APPROVED');
  assert.equal(sent.length, 2);

  // Documento que no existe
  assert.equal((await call('POST', '/api/documentos/documents/999999/send', 'admin')).status, 404);
});

test('solo el admin cambia el switch', async () => {
  let res = await call('PUT', '/api/settings/bot', 'hengi', { digitadores_aprueban_documentos: true });
  assert.equal(res.status, 403);
  assert.equal((await pool.query(`SELECT valor FROM business_info WHERE clave = 'digitadores_aprueban_documentos'`)).rows[0].valor, false);

  res = await call('PUT', '/api/settings/bot', 'admin', { digitadores_aprueban_documentos: 'sí' });
  assert.equal(res.status, 400);

  res = await setSwitch(true);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { digitadores_aprueban_documentos: true });
  assert.equal((await pool.query(`SELECT valor FROM business_info WHERE clave = 'digitadores_aprueban_documentos'`)).rows[0].valor, true);
  // Todos lo pueden leer, y se ve al momento (la caché se limpió)
  res = await call('GET', '/api/settings/bot', 'hengi');
  assert.deepEqual(await res.json(), { digitadores_aprueban_documentos: true });
  res = await call('GET', '/api/settings/bot', 'marleni');
  assert.deepEqual(await res.json(), { digitadores_aprueban_documentos: true });

  res = await setSwitch(false);
  assert.deepEqual(await res.json(), { digitadores_aprueban_documentos: false });
  assert.deepEqual(await (await call('GET', '/api/settings/bot', 'admin')).json(), { digitadores_aprueban_documentos: false });

  const log = (await pool.query(`SELECT actor_id, category, summary FROM activity_log ORDER BY id`)).rows;
  assert.equal(log.length, 2);
  assert.ok(log.every((l) => l.actor_id === ids.admin && l.category === 'documentos'));
  assert.match(log[0].summary, /digitadores/i);
  assert.match(log[1].summary, /digitadores/i);
});

test('T3: aprobar con al_pagar un documento sin cotización responde 400 NO_INVOICE y no aprueba nada', async () => {
  const doc = await makeDoc({ invoiceId: null });
  const res = await call('POST', `/api/documentos/documents/${doc.id}/approve`, 'admin', { version_id: doc.versionId, send_mode: 'al_pagar' });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, 'NO_INVOICE');
  assert.match(body.error, /cotización/);
  assert.equal((await docRow(doc.id)).approved_version_id, null);
  assert.equal((await docRow(doc.id)).send_mode, null);
  assert.equal(sent.length, 0);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM activity_log')).rows[0].n, 0);

  // Con cotización sí
  const inv = await makeInvoice('approved');
  const ok = await makeDoc({ invoiceId: inv.id });
  const r2 = await call('POST', `/api/documentos/documents/${ok.id}/approve`, 'admin', { version_id: ok.versionId, send_mode: 'al_pagar' });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).document.send_mode, 'al_pagar');
});
