const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

// Files go to a throwaway volume; templates come from a throwaway folder
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-docs-'));
const TPL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-tpl-'));
process.env.GURU_TEMPLATES_BASE_DIR = TPL_DIR;

const pdf = require('../src/documentos/pdf');
const aiSearch = require('../src/documentos/aiSearch');
const { searchTemplates } = require('../src/documentos/templatesCatalog');
const { generateToken } = require('../src/middleware/auth');

const DOCX = Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.from('fake word content')]);
const PDF = Buffer.from('%PDF-1.4 fake');
let conversions = 0;
pdf.setConverter(async (input, outDir) => {
  conversions++;
  const out = path.join(outDir, path.basename(input).replace(/\.docx$/i, '.pdf'));
  fs.writeFileSync(out, PDF);
  return out;
});

let server, base, tok = {}, ids = {};

test.before(async () => {
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Leandro','admin'), ('hengi','hengi@x.com','x','Hengi','digitador'),
    ('marleni','marleni@x.com','x','Marleni','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  // Minimal copies of production tables this module reads
  await pool.query('DROP TABLE IF EXISTS portfolio_versions, portfolio_documents, clients, doc_templates, doc_categories CASCADE');
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, email TEXT, address TEXT, notes TEXT, user_id INT, source TEXT, assigned_to INT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, description TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  await pool.query(`INSERT INTO doc_categories (name) VALUES ('DECLARACIONES'), ('CONTRATOS')`);
  fs.mkdirSync(path.join(TPL_DIR, 'DECLARACIONES'), { recursive: true });
  fs.writeFileSync(path.join(TPL_DIR, 'DECLARACIONES', 'DECLARACION JURADA DE INGRESOS.docx'), DOCX);
  await pool.query(`INSERT INTO doc_templates (name, file_path, file_name, category_id, is_active) VALUES
    ('DECLARACIÓN JURADA DE INGRESOS', 'DECLARACIONES/DECLARACION JURADA DE INGRESOS.docx', 'DECLARACION JURADA DE INGRESOS.docx', 1, TRUE),
    ('CONTRATO DE ALQUILER DE VIVIENDA', 'CONTRATOS/ALQUILER.docx', 'ALQUILER.docx', 2, TRUE),
    ('PODER ESPECIAL', 'CONTRATOS/PODER.docx', 'PODER.docx', 2, TRUE),
    ('MODELO VIEJO', 'X.docx', 'X.docx', 2, FALSE)`);
  await pool.query(`INSERT INTO clients (name, phone) VALUES ('Juan Pérez', '18095550001'), ('María Gómez', '18095550002')`);
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20260929_portfolio.sql'); // idempotent
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) {
    tok[u.username] = generateToken(u);
    ids[u.username] = u.id;
  }
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/documentos', require('../src/routes/documentos'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

const call = (method, p, who, body) =>
  fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` },
    body: body ? JSON.stringify(body) : undefined,
  });
const upload = (p, who, fields, file, name) => {
  const fd = new FormData();
  Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
  if (file) fd.append('file', new Blob([file]), name);
  return fetch(base + p, { method: 'POST', headers: { Authorization: `Bearer ${tok[who]}` }, body: fd });
};

// ── Nuestra selección ──
test('search ignores accents and word order, only active models', () => {
  const list = [
    { id: 1, name: 'DECLARACIÓN JURADA DE INGRESOS', category: 'DECLARACIONES' },
    { id: 2, name: 'CONTRATO DE ALQUILER DE VIVIENDA', category: 'CONTRATOS' },
  ];
  assert.deepEqual(searchTemplates(list, 'declaracion ingresos').map((t) => t.id), [1]);
  assert.deepEqual(searchTemplates(list, 'vivienda alquiler').map((t) => t.id), [2]);
  assert.equal(searchTemplates(list, 'contratos').length, 1); // category matches too
  assert.equal(searchTemplates(list, 'zzz').length, 0);
});

test('GET /models searches the selection; employees can use it', async () => {
  const res = await call('GET', '/api/documentos/models?q=declaracion', 'hengi');
  assert.equal(res.status, 200);
  const { models } = await res.json();
  assert.equal(models.length, 1);
  assert.equal(models[0].name, 'DECLARACIÓN JURADA DE INGRESOS');
  assert.equal(models[0].category, 'DECLARACIONES');
  const all = (await (await call('GET', '/api/documentos/models', 'hengi')).json()).models;
  assert.equal(all.length, 3); // inactive one hidden
});

test('AI search returns the models Gemini picked, ignoring invented ids', async () => {
  aiSearch.setGenerator(async (prompt) => {
    assert.match(prompt, /PODER ESPECIAL/);
    return JSON.stringify([{ id: 3, reason: 'Para representar a alguien' }, { id: 999, reason: 'inventado' }]);
  });
  const res = await call('POST', '/api/documentos/models/ai-search', 'hengi', { query: 'que alguien firme por mí' });
  assert.equal(res.status, 200);
  const { models } = await res.json();
  assert.deepEqual(models.map((m) => m.id), [3]);
  assert.equal(models[0].reason, 'Para representar a alguien');
});

test('a model downloads as Word or PDF (converted once) and is never saved to a history', async () => {
  const id = (await pool.query(`SELECT id FROM doc_templates WHERE name LIKE 'DECLARACI%'`)).rows[0].id;
  let res = await call('GET', `/api/documentos/models/${id}/file?format=docx`, 'hengi');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /\.docx/);
  res = await call('GET', `/api/documentos/models/${id}/file?format=pdf`, 'hengi');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  await call('GET', `/api/documentos/models/${id}/file?format=pdf`, 'hengi');
  assert.equal(conversions, 1);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM portfolio_documents')).rows[0].n, 0);
});

// ── Mi historial ──
test('upload creates a document with v1 for a client', async () => {
  const res = await upload('/api/documentos/documents', 'hengi', { client_id: 1, title: 'Contrato de alquiler', notes: 'primera' }, DOCX, 'contrato.docx');
  assert.equal(res.status, 201);
  const { document } = await res.json();
  assert.equal(document.title, 'Contrato de alquiler');
  assert.equal(document.versions.length, 1);
  assert.equal(document.versions[0].version_number, 1);
  assert.equal(document.versions[0].status, 'draft');
  ids.doc = document.id;
  ids.v1 = document.versions[0].id;
});

test('only Word or PDF files, checked by content', async () => {
  let res = await upload('/api/documentos/documents', 'hengi', { client_id: 1, title: 'X' }, Buffer.from('MZ evil'), 'virus.docx');
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, 'INVALID_FILE');
  res = await upload('/api/documentos/documents', 'hengi', { client_id: 1, title: 'X' }, PDF, 'nota.txt');
  assert.equal(res.status, 400);
  res = await upload('/api/documentos/documents', 'hengi', { client_id: 999, title: 'X' }, PDF, 'a.pdf');
  assert.equal(res.status, 400);
});

test('new versions are numbered in order', async () => {
  const res = await upload(`/api/documentos/documents/${ids.doc}/versions`, 'hengi', { notes: 'con cambios' }, PDF, 'contrato-v2.pdf');
  assert.equal(res.status, 201);
  const { document } = await res.json();
  assert.deepEqual(document.versions.map((v) => v.version_number), [2, 1]);
  ids.v2 = document.versions[0].id;
});

test('only the admin approves, and only one version is approved', async () => {
  assert.equal((await call('POST', `/api/documentos/documents/${ids.doc}/approve`, 'hengi', { version_id: ids.v2 })).status, 403);
  let res = await call('POST', `/api/documentos/documents/${ids.doc}/approve`, 'admin', { version_id: ids.v1 });
  assert.equal(res.status, 200);
  res = await call('POST', `/api/documentos/documents/${ids.doc}/approve`, 'admin', { version_id: ids.v2 });
  const { document } = await res.json();
  assert.deepEqual(document.versions.map((v) => v.status), ['approved', 'draft']);
  const log = (await pool.query(`SELECT summary FROM activity_log WHERE action = 'documento.approve' ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.match(log.summary, /v2/);
});

test("employees only see what they created; the admin sees everything", async () => {
  await upload('/api/documentos/documents', 'marleni', { client_id: 2, title: 'Poder especial' }, PDF, 'poder.pdf');
  const hengi = (await (await call('GET', '/api/documentos/documents', 'hengi')).json()).documents;
  assert.deepEqual(hengi.map((d) => d.title), ['Contrato de alquiler']);
  const marleniClients = (await (await call('GET', '/api/documentos/clients', 'marleni')).json()).clients;
  assert.deepEqual(marleniClients.map((c) => c.name), ['María Gómez']);
  const all = (await (await call('GET', '/api/documentos/documents', 'admin')).json()).documents;
  assert.equal(all.length, 2);
  const byMarleni = (await (await call('GET', `/api/documentos/documents?created_by=${ids.marleni}`, 'admin')).json()).documents;
  assert.deepEqual(byMarleni.map((d) => d.title), ['Poder especial']);
  // Marleni cannot open, download or add versions to Hengi's document
  assert.equal((await call('GET', `/api/documentos/versions/${ids.v1}/file`, 'marleni')).status, 404);
  assert.equal((await upload(`/api/documentos/documents/${ids.doc}/versions`, 'marleni', {}, PDF, 'x.pdf')).status, 404);
});

test('versions download as Word or PDF', async () => {
  let res = await call('GET', `/api/documentos/versions/${ids.v1}/file?format=docx`, 'hengi');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /contrato\.docx/);
  res = await call('GET', `/api/documentos/versions/${ids.v1}/file?format=pdf&inline=1`, 'admin');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition'), /^inline/);
  // A PDF version has no Word file
  assert.equal((await call('GET', `/api/documentos/versions/${ids.v2}/file?format=docx`, 'hengi')).status, 400);
});

test('sorting by name, date and recent', async () => {
  await upload('/api/documentos/documents', 'hengi', { client_id: 1, title: 'Acto de venta' }, PDF, 'venta.pdf');
  const byName = (await (await call('GET', '/api/documentos/documents?client_id=1&sort=name', 'hengi')).json()).documents;
  assert.deepEqual(byName.map((d) => d.title), ['Acto de venta', 'Contrato de alquiler']);
  const recent = (await (await call('GET', '/api/documentos/documents?client_id=1&sort=recent', 'hengi')).json()).documents;
  assert.equal(recent[0].title, 'Acto de venta');
});

test('without LibreOffice the PDF answers clearly and Word still works', async () => {
  pdf.setConverter(async () => { const e = new Error('soffice missing'); e.code = 'PDF_UNAVAILABLE'; throw e; });
  const up = await upload('/api/documentos/documents', 'hengi', { client_id: 1, title: 'Sin PDF' }, DOCX, 'sinpdf.docx');
  const v = (await up.json()).document.versions[0].id;
  const res = await call('GET', `/api/documentos/versions/${v}/file?format=pdf`, 'hengi');
  assert.equal(res.status, 503);
  assert.equal((await res.json()).code, 'PDF_UNAVAILABLE');
  assert.equal((await call('GET', `/api/documentos/versions/${v}/file?format=docx`, 'hengi')).status, 200);
});
