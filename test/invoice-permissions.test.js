const { pool, resetDb } = require('./helpers/db');
const { resetAssignmentTables } = require('./helpers/assignments');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

// Invoice PDFs go to a throwaway folder instead of the Railway volume
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-inv-'));
const storage = require('../src/utils/storage');
const outgoing = require('../src/whatsapp/outgoing');
const Message = require('../src/models/Message');
const { generateToken } = require('../src/middleware/auth');

const sent = [];
outgoing.sendDocument = async (to, file) => { sent.push({ to, file }); };
Message.getLastJid = async () => null;

let server, base, tok = {}, ids = {};

// Minimal invoices table with the columns the model uses (production has more)
async function resetInvoices() {
  await pool.query('DROP TABLE IF EXISTS invoices CASCADE');
  await pool.query(`CREATE TABLE invoices (
    id SERIAL PRIMARY KEY, doc_number TEXT, type TEXT DEFAULT 'COTIZACIÓN', status TEXT DEFAULT 'draft',
    client_id INT, case_id INT, client_name TEXT, client_phone TEXT, items JSONB DEFAULT '[]', notes TEXT,
    subtotal NUMERIC DEFAULT 0, itbis NUMERIC DEFAULT 0, total NUMERIC DEFAULT 0, created_by INT, source TEXT,
    pdf_path TEXT, pdf_s3_key TEXT, pdf_storage_type TEXT, approved_by INT, approved_at TIMESTAMPTZ,
    rejected_by INT, rejected_at TIMESTAMPTZ, sent_at TIMESTAMPTZ, paid_by INT, paid_at TIMESTAMPTZ,
    payment_method TEXT, payment_reference TEXT, discount_type TEXT, discount_value NUMERIC DEFAULT 0,
    discount_code TEXT, discount_amount NUMERIC DEFAULT 0, discount_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
}

// A quote with a PDF already on disk, so routes never need to render one
async function quote(owner, status, { clientId = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO invoices (doc_number, status, created_by, client_id, client_phone, client_name, total)
     VALUES ('TMP', $1, $2, $3, '18095550000', 'Cliente', 100) RETURNING id`,
    [status, ids[owner], clientId]
  );
  const id = rows[0].id;
  const file = storage.getFilePath('invoices', `COT-${id}.pdf`);
  fs.writeFileSync(file, '%PDF-1.4 test');
  await pool.query(`UPDATE invoices SET doc_number = $1, pdf_path = $2 WHERE id = $3`, [`COT-${id}`, file, id]);
  return id;
}
const statusOf = async (id) => (await pool.query('SELECT status FROM invoices WHERE id = $1', [id])).rows[0]?.status;

test.before(async () => {
  await resetDb();
  await resetAssignmentTables();
  await resetInvoices();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Admin','admin'), ('hengi','hengi@x.com','x','Hengi','digitador'),
    ('marleni','marleni@x.com','x','Marleni','digitador')`);
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) {
    tok[u.username] = generateToken(u);
    ids[u.username] = u.id;
  }
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/invoices', require('../src/routes/invoices'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });
test.beforeEach(() => { sent.length = 0; });

const call = (method, p, who, body) =>
  fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });

test('an employee cannot WhatsApp a quote the admin has not approved', async () => {
  for (const [status, http, code] of [['draft', 403, 'APPROVAL_REQUIRED'], ['pending_approval', 403, 'APPROVAL_REQUIRED'], ['rejected', 400, 'REJECTED']]) {
    const id = await quote('hengi', status);
    const res = await call('POST', `/api/invoices/${id}/send-whatsapp`, 'hengi');
    assert.equal(res.status, http, status);
    assert.equal((await res.json()).code, code);
    assert.equal(await statusOf(id), status);
  }
  assert.equal(sent.length, 0);
});

test('an employee can WhatsApp their own quote once approved', async () => {
  const id = await quote('hengi', 'approved');
  const res = await call('POST', `/api/invoices/${id}/send-whatsapp`, 'hengi');
  assert.equal(res.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(await statusOf(id), 'sent');
});

test('the admin sends directly (approving it), but never a rejected quote', async () => {
  const id = await quote('hengi', 'pending_approval');
  let res = await call('POST', `/api/invoices/${id}/send-whatsapp`, 'admin');
  assert.equal(res.status, 200);
  assert.equal(await statusOf(id), 'sent');
  const approvedBy = (await pool.query('SELECT approved_by FROM invoices WHERE id = $1', [id])).rows[0].approved_by;
  assert.equal(approvedBy, ids.admin);

  const rejected = await quote('hengi', 'rejected');
  res = await call('POST', `/api/invoices/${rejected}/send-whatsapp`, 'admin');
  assert.equal(res.status, 400);
  assert.equal(sent.length, 1);
});

test('an employee asks for approval from a draft', async () => {
  const id = await quote('hengi', 'draft');
  let res = await call('POST', `/api/invoices/${id}/request-approval`, 'hengi');
  assert.equal(res.status, 200);
  assert.equal(await statusOf(id), 'pending_approval');
  res = await call('POST', `/api/invoices/${id}/request-approval`, 'hengi');
  assert.equal(res.status, 400);
  const other = await quote('hengi', 'draft');
  assert.equal((await call('POST', `/api/invoices/${other}/request-approval`, 'marleni')).status, 403);
});

test('GET /quotations only shows an employee their own quotes', async () => {
  await quote('marleni', 'draft');
  const mine = (await (await call('GET', '/api/invoices/quotations', 'hengi')).json()).quotations;
  assert.ok(mine.length > 0);
  assert.ok(mine.every((q) => q.created_by === ids.hengi));
  const all = (await (await call('GET', '/api/invoices/quotations', 'admin')).json()).quotations;
  assert.ok(all.some((q) => q.created_by === ids.marleni));
});

test('PDF by filename: owner, assigned employee and admin only', async () => {
  const id = await quote('marleni', 'sent');
  const url = `/api/invoices/pdf/COT-${id}.pdf`;
  assert.equal((await call('GET', url, 'hengi')).status, 403);
  assert.equal((await call('GET', url, 'marleni')).status, 200);
  assert.equal((await call('GET', url, 'admin')).status, 200);

  // A quote for a client assigned to Hengi (created by someone else) is visible to Hengi
  const { rows } = await pool.query('INSERT INTO clients (phone, assigned_to) VALUES ($1, $2) RETURNING id', ['1', ids.hengi]);
  const assigned = await quote('marleni', 'sent', { clientId: rows[0].id });
  assert.equal((await call('GET', `/api/invoices/pdf/COT-${assigned}.pdf`, 'hengi')).status, 200);

  // A file not linked to any quote: admin only
  fs.writeFileSync(storage.getFilePath('invoices', 'orphan.pdf'), '%PDF');
  assert.equal((await call('GET', '/api/invoices/pdf/orphan.pdf', 'hengi')).status, 403);
  assert.equal((await call('GET', '/api/invoices/pdf/orphan.pdf', 'admin')).status, 200);
});

test('an employee can only delete their quote before it is approved', async () => {
  for (const status of ['approved', 'paid', 'sent']) {
    const id = await quote('hengi', status);
    assert.equal((await call('DELETE', `/api/invoices/${id}`, 'hengi')).status, 400, status);
    assert.equal(await statusOf(id), status);
  }
  for (const status of ['draft', 'pending_approval', 'rejected']) {
    const id = await quote('hengi', status);
    assert.equal((await call('DELETE', `/api/invoices/${id}`, 'hengi')).status, 200, status);
  }
  const approved = await quote('hengi', 'approved');
  assert.equal((await call('DELETE', `/api/invoices/${approved}`, 'admin')).status, 200);
});
