// Avisos de la campana para el flujo de aprobación de cotizaciones y facturas.
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-invnotif-'));

const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const { generateToken } = require('../src/middleware/auth');

let server, base, adminId, admin2Id, digitadorId, clientId, tok;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/invoices', require('../src/routes/invoices'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await createAgentSchema();
  await pool.query(`ALTER TABLE invoices ADD COLUMN pdf_path TEXT, ADD COLUMN pdf_s3_key TEXT, ADD COLUMN pdf_storage_type TEXT,
    ADD COLUMN sent_at TIMESTAMPTZ, ADD COLUMN rejected_by INT, ADD COLUMN rejected_at TIMESTAMPTZ,
    ADD COLUMN paid_by INT, ADD COLUMN paid_at TIMESTAMPTZ, ADD COLUMN payment_method TEXT, ADD COLUMN payment_reference TEXT`);
  await pool.query('DROP TABLE IF EXISTS activity_log CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  adminId = await createUser('leandro', 'admin', 'Leandro');
  admin2Id = await createUser('socio', 'admin', 'Socio');
  digitadorId = await createUser('hengi', 'digitador', 'Hengi');
  tok = {
    admin: generateToken({ id: adminId, username: 'leandro', email: 'leandro@t.co', role: 'admin' }),
    hengi: generateToken({ id: digitadorId, username: 'hengi', email: 'hengi@t.co', role: 'digitador' }),
  };
  clientId = (await pool.query(`INSERT INTO clients (phone, name) VALUES ('18095550001', 'Juan Pérez') RETURNING id`)).rows[0].id;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (p, who, body = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: JSON.stringify(body) });
const notifs = async (userId) => (await pool.query('SELECT type, title, message, link FROM notifications WHERE user_id = $1 ORDER BY id', [userId])).rows;

async function makeInvoice(status, createdBy, type = 'COTIZACIÓN') {
  const { rows } = await pool.query(
    `INSERT INTO invoices (doc_number, type, status, client_id, client_name, client_phone, items, subtotal, itbis, total, created_by, source)
     VALUES ('COT-2026-001', $1, $2, $3, 'Juan Pérez', '18095550001', '[]', 1500, 0, 1500, $4, 'dashboard') RETURNING *`,
    [type, status, clientId, createdBy]);
  return rows[0];
}

test('el digitador pide aprobación: avisa a cada admin activo, no al digitador', async () => {
  const inv = await makeInvoice('draft', digitadorId);
  assert.equal((await call(`/api/invoices/${inv.id}/request-approval`, 'hengi')).status, 200);
  for (const id of [adminId, admin2Id]) {
    const n = await notifs(id);
    assert.equal(n.length, 1);
    assert.equal(n[0].type, 'approval');
    assert.match(n[0].title, /por aprobar/i);
    assert.match(n[0].message, /Hengi/);
    assert.match(n[0].message, /COT-2026-001/);
    assert.match(n[0].message, /Juan Pérez/);
    assert.equal(n[0].link, `/cotizaciones?invoice=${inv.id}`);
  }
  assert.equal((await notifs(digitadorId)).length, 0);
});

test('enviar un borrador como digitador también pide aprobación y avisa', async () => {
  const inv = await makeInvoice('draft', digitadorId);
  assert.equal((await call(`/api/invoices/${inv.id}/send`, 'hengi')).status, 200);
  assert.equal((await notifs(adminId)).length, 1);
});

test('un admin inactivo no recibe el aviso', async () => {
  await pool.query('UPDATE users SET is_active = false WHERE id = $1', [admin2Id]);
  const inv = await makeInvoice('draft', digitadorId);
  await call(`/api/invoices/${inv.id}/request-approval`, 'hengi');
  assert.equal((await notifs(admin2Id)).length, 0);
  assert.equal((await notifs(adminId)).length, 1);
});

test('el admin aprueba: avisa al digitador que la creó', async () => {
  const inv = await makeInvoice('pending_approval', digitadorId);
  assert.equal((await call(`/api/invoices/${inv.id}/approve`, 'admin')).status, 200);
  const n = await notifs(digitadorId);
  assert.equal(n.length, 1);
  assert.equal(n[0].type, 'approval');
  assert.match(n[0].title, /aprobada/i);
  assert.match(n[0].message, /COT-2026-001/);
  assert.equal(n[0].link, `/cotizaciones?invoice=${inv.id}`);
});

test('el admin rechaza: avisa al digitador con el motivo', async () => {
  const inv = await makeInvoice('pending_approval', digitadorId, 'FACTURA');
  assert.equal((await call(`/api/invoices/${inv.id}/reject`, 'admin', { reason: 'Falta el ITBIS' })).status, 200);
  const n = await notifs(digitadorId);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /rechazada/i);
  assert.match(n[0].message, /factura COT-2026-001/);
  assert.match(n[0].message, /Falta el ITBIS/);
});

test('aprobar algo creado por un admin o por el bot no crea avisos', async () => {
  const own = await makeInvoice('pending_approval', adminId);
  await call(`/api/invoices/${own.id}/approve`, 'admin');
  const bot = await makeInvoice('pending_approval', null);
  await call(`/api/invoices/${bot.id}/reject`, 'admin', {});
  const { rows } = await pool.query('SELECT count(*)::int n FROM notifications');
  assert.equal(rows[0].n, 0);
});

test('aprobar y enviar algo del digitador también le avisa', async () => {
  const delivery = require('../src/agent/delivery');
  delivery._setSender({ sendDocument: async () => ({ key: { id: 'wa-1' } }) });
  await pool.query(`CREATE UNIQUE INDEX idx_messages_wa_message_id_unique ON messages(wa_message_id) WHERE wa_message_id IS NOT NULL`);
  await pool.query('DROP TABLE IF EXISTS portfolio_versions, portfolio_documents CASCADE');
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  await runSqlFile('migrations/20261007_delivery_wa_id.sql');
  const inv = await makeInvoice('pending_approval', digitadorId);
  await call(`/api/invoices/${inv.id}/approve-and-send`, 'admin');
  const n = await notifs(digitadorId);
  assert.equal(n.filter((x) => /aprobada/i.test(x.title)).length, 1);
});
