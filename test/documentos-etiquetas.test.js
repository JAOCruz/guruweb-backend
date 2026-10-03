const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');

const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-tags-'));
const TPL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-tpl-tags-'));
process.env.GURU_TEMPLATES_BASE_DIR = TPL_DIR;

const aiDocs = require('../src/documentos/aiDocs');
const { listBlocks } = require('../src/documentos/docxText');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {};
let ai = async () => { throw new Error('unexpected AI call'); };
aiDocs.setGenerator((parts) => ai(parts));

const VENTA = [
  'ACTO DE VENTA',
  'Yo, JOSE ANTONIO PEREZ, cédula 001-0000000-1, vendo a MARIA LOPEZ el vehículo.',
  'PRIMERO: El precio es RD$100,000.',
];
const makeDocx = (file, paragraphs) =>
  spawnSync(PY, ['-c', `import sys, json\nfrom docx import Document\nd = Document()\nfor t in json.loads(sys.argv[2]): d.add_paragraph(t)\nd.save(sys.argv[1])`, file, JSON.stringify(paragraphs)]);

// What Gemini answers when tagging VENTA (paragraph 2 changes the wording → skipped)
const AI_TAGS = JSON.stringify({
  paragraphs: [
    { i: 1, text: 'Yo, {{NOMBRE_VENDEDOR}}, cédula {{DOCUMENTO IDENTIDAD_VENDEDOR}}, vendo a {{NOMBRE_COMPRADOR}} el vehículo.' },
    { i: 2, text: 'PRIMERO: El precio será {{PRECIO_VENTA_NUMEROS}}.' },
  ],
  tags: [
    { key: 'NOMBRE_VENDEDOR', label: 'Nombre del vendedor', group: 'VENDEDOR' },
    { key: 'DOCUMENTO IDENTIDAD_VENDEDOR', label: 'Cédula del vendedor', group: 'VENDEDOR' },
    { key: 'NOMBRE_COMPRADOR', label: 'Nombre del comprador', group: 'COMPRADOR' },
  ],
});

test.before(async () => {
  if (!hasDocx) return;
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Leandro','admin'), ('hengi','hengi@x.com','x','Hengi','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query('DROP TABLE IF EXISTS template_tag_versions, legal_profiles, portfolio_versions, portfolio_documents, clients, doc_template_variables, doc_variables, doc_templates, doc_categories CASCADE');
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, email TEXT, address TEXT, notes TEXT, user_id INT, source TEXT, assigned_to INT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, description TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  await pool.query(`CREATE TABLE doc_variables (id SERIAL PRIMARY KEY, tag TEXT, description TEXT, is_rol_dynamic BOOLEAN DEFAULT FALSE, rol_type TEXT)`);
  await pool.query(`CREATE TABLE doc_template_variables (id SERIAL PRIMARY KEY, template_id INT, variable_id INT, is_required BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0)`);
  makeDocx(path.join(TPL_DIR, 'venta.docx'), VENTA);
  makeDocx(path.join(TPL_DIR, 'poder.docx'), ['PODER', 'Otorgo poder a LUIS DIAZ.']);
  await pool.query(`INSERT INTO doc_categories (name) VALUES ('Vehículos')`);
  await pool.query(`INSERT INTO doc_templates (name, file_path, file_name, category_id) VALUES
    ('ACTO DE VENTA', 'venta.docx', 'venta.docx', 1), ('PODER', 'poder.docx', 'poder.docx', 1), ('VIEJO', 'viejo.doc', 'viejo.doc', 1)`);
  await pool.query(`INSERT INTO doc_variables (tag, is_rol_dynamic, rol_type) VALUES ('NOMBRE_[ROL]', TRUE, 'VENDEDOR')`);
  await pool.query(`INSERT INTO doc_template_variables (template_id, variable_id) VALUES (1, 1)`);
  await pool.query(`INSERT INTO clients (name, phone) VALUES ('Juan Pérez', '18095550001')`);
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  await runSqlFile('migrations/20261002_template_tags.sql');
  await runSqlFile('migrations/20261002_template_tags.sql'); // idempotent
  await pool.query(`INSERT INTO legal_profiles (client_id, data) VALUES (1, '{"NOMBRE": "JUAN PÉREZ", "DOCUMENTO IDENTIDAD": "402-1111111-2"}')`);
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) tok[u.username] = generateToken(u);
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/documentos/tags', require('../src/routes/documentosTags'));
  app.use('/api/documentos', require('../src/routes/documentos'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) server.close(); await pool.end(); });

const call = (method, p, who, body) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: body ? JSON.stringify(body) : undefined });
const versionText = async (id) => {
  const { rows } = await pool.query('SELECT file_path FROM template_tag_versions WHERE id = $1', [id]);
  return (await listBlocks(rows[0].file_path)).map((b) => b.text);
};
const opts = { skip: !hasDocx };

test('admin-only: employees cannot tag, edit, approve or see the summary', opts, async () => {
  for (const [m, p] of [['GET', '/summary'], ['POST', '/models/1/ai'], ['POST', '/batch'], ['POST', '/models/1/edit'], ['POST', '/versions/1/approve']]) {
    assert.equal((await call(m, `/api/documentos/tags${p}`, 'hengi', m === 'GET' ? undefined : {})).status, 403, `${m} ${p}`);
  }
});

test('AI tagging creates v1 pending, keeps the wording, reports skipped paragraphs and the sample values', opts, async () => {
  let prompt = '';
  ai = async (p) => { prompt = p; return AI_TAGS; };
  const res = await call('POST', '/api/documentos/tags/models/1/ai', 'admin');
  assert.equal(res.status, 201);
  const { model } = await res.json();
  assert.match(prompt, /NOMBRE_VENDEDOR/); // MotherBrain's tags go as vocabulary
  assert.equal(model.status, 'pending');
  assert.equal(model.versions.length, 1);
  const v = model.versions[0];
  assert.equal(v.version_number, 1);
  assert.equal(v.source, 'ai');
  assert.deepEqual(v.tags.map((t) => [t.key, t.group, t.example]), [
    ['NOMBRE_VENDEDOR', 'VENDEDOR', 'JOSE ANTONIO PEREZ'],
    ['DOCUMENTO IDENTIDAD_VENDEDOR', 'VENDEDOR', '001-0000000-1'],
    ['NOMBRE_COMPRADOR', 'COMPRADOR', 'MARIA LOPEZ'],
  ]);
  assert.deepEqual(v.skipped.map((s) => s.i), [2]);
  assert.deepEqual(await versionText(v.id), [
    'ACTO DE VENTA',
    'Yo, {{NOMBRE_VENDEDOR}}, cédula {{DOCUMENTO IDENTIDAD_VENDEDOR}}, vendo a {{NOMBRE_COMPRADOR}} el vehículo.',
    'PRIMERO: El precio es RD$100,000.',
  ]);
  // the original model file is never touched
  assert.equal(spawnSync(PY, ['-c', 'import sys\nfrom docx import Document\nprint(Document(sys.argv[1]).paragraphs[1].text)', path.join(TPL_DIR, 'venta.docx')]).stdout.toString().trim(), VENTA[1]);
});

test('AI tagging that aligns nothing answers 422 and creates no version', opts, async () => {
  ai = async () => JSON.stringify({ paragraphs: [{ i: 1, text: 'Otorgo un poder a {{NOMBRE}}.' }], tags: [] });
  const res = await call('POST', '/api/documentos/tags/models/2/ai', 'admin');
  assert.equal(res.status, 422);
  const { rows } = await pool.query('SELECT COUNT(*)::int n FROM template_tag_versions WHERE template_id = 2');
  assert.equal(rows[0].n, 0);
});

test('models list and summary show the status of each model', opts, async () => {
  const { models } = await (await call('GET', '/api/documentos/models', 'admin')).json();
  const byName = Object.fromEntries(models.map((m) => [m.name, m.tag_status]));
  assert.deepEqual(byName, { 'ACTO DE VENTA': 'pending', PODER: 'untagged', VIEJO: 'untagged' });
  const summary = await (await call('GET', '/api/documentos/tags/summary', 'admin')).json();
  assert.deepEqual(summary.counts, { untagged: 2, pending: 1, approved: 0 });
  assert.equal(summary.models.find((m) => m.name === 'VIEJO').taggable, false); // .doc cannot be tagged
});

test('employees cannot open or fill a model that is not approved; the admin can open it', opts, async () => {
  assert.equal((await call('GET', '/api/documentos/tags/models/1', 'hengi')).status, 404);
  assert.equal((await call('POST', '/api/documentos/tags/models/1/fill', 'hengi', { values: {}, client_id: 1 })).status, 404);
  const res = await call('GET', '/api/documentos/tags/models/1', 'admin');
  assert.equal(res.status, 200);
  const { model } = await res.json();
  assert.equal(model.name, 'ACTO DE VENTA');
  assert.equal(model.category, 'Vehículos');
  assert.equal(model.current.version_number, 1);
});

test('edits make a new pending version: tag a selection, rename, change label, remove a tag', opts, async () => {
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  const p2 = 'PRIMERO: El precio es RD$100,000.';
  const res = await call('POST', '/api/documentos/tags/models/1/edit', 'admin', {
    base_version_id: model.current.id,
    notes: 'Precio y comprador',
    ops: [
      { op: 'tag', text: p2, offset: p2.indexOf('RD$'), length: 'RD$100,000'.length, key: 'precio_venta_numeros', label: 'Precio (números)', group: 'DOCUMENTO' },
      { op: 'rename', from: 'NOMBRE_COMPRADOR', key: 'NOMBRE_ADQUIRIENTE', group: 'COMPRADOR' },
      { op: 'meta', key: 'NOMBRE_VENDEDOR', label: 'Vendedor (nombre completo)' },
      { op: 'untag', key: 'DOCUMENTO IDENTIDAD_VENDEDOR' },
    ],
  });
  assert.equal(res.status, 201);
  const { model: after } = await res.json();
  assert.equal(after.status, 'pending');
  const v2 = after.versions[0];
  assert.equal(v2.version_number, 2);
  assert.equal(v2.source, 'edit');
  assert.equal(v2.notes, 'Precio y comprador');
  assert.deepEqual(await versionText(v2.id), [
    'ACTO DE VENTA',
    'Yo, {{NOMBRE_VENDEDOR}}, cédula 001-0000000-1, vendo a {{NOMBRE_ADQUIRIENTE}} el vehículo.',
    'PRIMERO: El precio es {{PRECIO_VENTA_NUMEROS}}.',
  ]);
  assert.deepEqual(v2.tags.map((t) => [t.key, t.label, t.group, t.example]), [
    ['NOMBRE_VENDEDOR', 'Vendedor (nombre completo)', 'VENDEDOR', 'JOSE ANTONIO PEREZ'],
    ['NOMBRE_ADQUIRIENTE', 'Nombre del comprador', 'COMPRADOR', 'MARIA LOPEZ'],
    ['PRECIO_VENTA_NUMEROS', 'Precio (números)', 'DOCUMENTO', 'RD$100,000'],
  ]);
});

test('an edit on an old version answers 409; a selection over a tag or not found answers 400', opts, async () => {
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  const stale = model.versions.find((v) => v.version_number === 1).id;
  assert.equal((await call('POST', '/api/documentos/tags/models/1/edit', 'admin', { base_version_id: stale, ops: [{ op: 'meta', key: 'NOMBRE_VENDEDOR', label: 'x' }] })).status, 409);
  const p = 'Yo, {{NOMBRE_VENDEDOR}}, cédula 001-0000000-1, vendo a {{NOMBRE_ADQUIRIENTE}} el vehículo.';
  const overTag = await call('POST', '/api/documentos/tags/models/1/edit', 'admin', { base_version_id: model.current.id, ops: [{ op: 'tag', text: p, offset: 2, length: 10, key: 'X' }] });
  assert.equal(overTag.status, 400);
  const missing = await call('POST', '/api/documentos/tags/models/1/edit', 'admin', { base_version_id: model.current.id, ops: [{ op: 'tag', text: 'no existe', offset: 0, length: 2, key: 'X' }] });
  assert.equal(missing.status, 400);
});

test('approve: the model becomes approved and employees can open it', opts, async () => {
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  const res = await call('POST', `/api/documentos/tags/versions/${model.current.id}/approve`, 'admin');
  assert.equal(res.status, 200);
  const { model: approved } = await res.json();
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approved.version_number, 2);
  assert.equal(approved.approved.approved_by_name, 'Leandro');
  const emp = await (await call('GET', '/api/documentos/tags/models/1', 'hengi')).json();
  assert.equal(emp.model.current.version_number, 2);
  assert.equal(emp.model.versions, undefined); // employees only get the approved version
});

test('a newer pending version leaves the approved one in use; restore makes a pending copy', opts, async () => {
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  const v1 = model.versions.find((v) => v.version_number === 1).id;
  const res = await call('POST', '/api/documentos/tags/models/1/restore', 'admin', { version_id: v1 });
  assert.equal(res.status, 201);
  const { model: after } = await res.json();
  assert.equal(after.status, 'pending');
  assert.equal(after.versions[0].version_number, 3);
  assert.equal(after.versions[0].source, 'restore');
  assert.equal(after.approved.version_number, 2);
  const emp = await (await call('GET', '/api/documentos/tags/models/1', 'hengi')).json();
  assert.equal(emp.model.current.version_number, 2);
});

test('fill: exact values, empty tags become blanks, saved to the client history and profile', opts, async () => {
  const res = await call('POST', '/api/documentos/tags/models/1/fill', 'hengi', {
    client_id: 1, client_role: 'VENDEDOR', title: 'Venta Juan',
    values: { NOMBRE_VENDEDOR: 'JUAN PÉREZ', PRECIO_VENTA_NUMEROS: 'RD$250,000.00', NO_EXISTE: 'x' },
  });
  assert.equal(res.status, 201);
  const { document } = await res.json();
  assert.equal(document.title, 'Venta Juan');
  assert.equal(document.template_id, 1);
  assert.equal(document.versions[0].source, 'generated');
  const { rows } = await pool.query('SELECT file_path FROM portfolio_versions WHERE id = $1', [document.versions[0].id]);
  assert.deepEqual((await listBlocks(rows[0].file_path)).map((b) => b.text), [
    'ACTO DE VENTA',
    'Yo, JUAN PÉREZ, cédula 001-0000000-1, vendo a ________ el vehículo.',
    'PRIMERO: El precio es RD$250,000.00.',
  ]);
  const profile = (await pool.query('SELECT data FROM legal_profiles WHERE client_id = 1')).rows[0].data;
  assert.equal(profile.NOMBRE, 'JUAN PÉREZ');
});

test('fill without a client answers 400', opts, async () => {
  assert.equal((await call('POST', '/api/documentos/tags/models/1/fill', 'hengi', { values: {} })).status, 400);
});

test('the tagged Word of a version downloads (employees: approved only)', opts, async () => {
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  const pending = model.versions[0].id;
  assert.equal((await call('GET', `/api/documentos/tags/versions/${model.approved.id}/file`, 'hengi')).status, 200);
  assert.equal((await call('GET', `/api/documentos/tags/versions/${pending}/file`, 'hengi')).status, 404);
  assert.equal((await call('GET', `/api/documentos/tags/versions/${pending}/file`, 'admin')).status, 200);
});

test('Personalizar keeps working on the original model as before (Etiquetas is its own flow)', opts, async () => {
  const res = await call('GET', '/api/documentos/fields?model_id=1', 'hengi');
  const body = await res.json();
  assert.equal(body.exact, false);
  assert.deepEqual(body.fields.map((f) => f.key), ['NOMBRE_VENDEDOR']); // MotherBrain's tags, as before
});

test('employees only see an approved flag in the models list, not pending', opts, async () => {
  const { models } = await (await call('GET', '/api/documentos/models', 'hengi')).json();
  assert.equal(models.find((m) => m.name === 'ACTO DE VENTA').tag_status, 'approved'); // v3 pending, v2 approved
  const admin = await (await call('GET', '/api/documentos/models', 'admin')).json();
  assert.equal(admin.models.find((m) => m.name === 'ACTO DE VENTA').tag_status, 'pending');
});

test('an admin can fill a chosen (pending) version', opts, async () => {
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  const v3 = model.versions[0];
  const res = await call('POST', '/api/documentos/tags/models/1/fill', 'admin', { client_id: 1, version_id: v3.id, values: { NOMBRE_COMPRADOR: 'ANA' } });
  const { document } = await res.json();
  const { rows } = await pool.query('SELECT file_path FROM portfolio_versions WHERE id = $1', [document.versions[0].id]);
  assert.match((await listBlocks(rows[0].file_path))[1].text, /vendo a ANA el/); // v3 = restored v1, has NOMBRE_COMPRADOR
});

test('a non-numeric id answers 404, not 500', opts, async () => {
  assert.equal((await call('GET', '/api/documentos/tags/models/abc', 'admin')).status, 404);
});

test('batch tags every untagged .docx model one by one and reports progress', opts, async () => {
  ai = async () => { await new Promise((r) => setTimeout(r, 50)); return JSON.stringify({ paragraphs: [{ i: 1, text: 'Otorgo poder a {{NOMBRE_APODERADO}}.' }], tags: [{ key: 'NOMBRE_APODERADO', group: 'APODERADO' }] }); };
  const [first, second] = await Promise.all([call('POST', '/api/documentos/tags/batch', 'admin'), call('POST', '/api/documentos/tags/batch', 'admin')]);
  assert.equal(first.status, 202);
  assert.equal((await first.json()).batch.running, true);
  assert.equal(second.status, 202);
  let job;
  for (let i = 0; i < 50; i++) {
    job = (await (await call('GET', '/api/documentos/tags/summary', 'admin')).json()).batch;
    if (!job.running) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(job.running, false);
  assert.equal(job.total, 1); // PODER only (VENTA has versions, VIEJO is .doc)
  assert.equal(job.done, 1);
  assert.deepEqual(job.failed, []);
  const summary = await (await call('GET', '/api/documentos/tags/summary', 'admin')).json();
  assert.deepEqual(summary.counts, { untagged: 1, pending: 2, approved: 0 });
});

test('removing a tag puts back the original text of each place', opts, async () => {
  makeDocx(path.join(TPL_DIR, 'dos.docx'), ['JUAN PÉREZ vende.', 'Firma: Juan Pérez']);
  await pool.query(`INSERT INTO doc_templates (name, file_path, file_name, category_id) VALUES ('DOS', 'dos.docx', 'dos.docx', 1)`);
  const id = (await pool.query(`SELECT id FROM doc_templates WHERE name = 'DOS'`)).rows[0].id;
  ai = async () => JSON.stringify({ paragraphs: [{ i: 0, text: '{{NOMBRE_VENDEDOR}} vende.' }, { i: 1, text: 'Firma: {{NOMBRE_VENDEDOR}}' }], tags: [] });
  const { model } = await (await call('POST', `/api/documentos/tags/models/${id}/ai`, 'admin')).json();
  assert.deepEqual(model.current.tags[0].examples, ['JUAN PÉREZ', 'Juan Pérez']);
  const res = await call('POST', `/api/documentos/tags/models/${id}/edit`, 'admin', { base_version_id: model.current.id, ops: [{ op: 'untag', key: 'NOMBRE_VENDEDOR' }] });
  const after = (await res.json()).model;
  assert.deepEqual(await versionText(after.current.id), ['JUAN PÉREZ vende.', 'Firma: Juan Pérez']);
});

test('a selection tagged with an existing key keeps its own text when that tag is removed later', opts, async () => {
  const id = (await pool.query(`SELECT id FROM doc_templates WHERE name = 'DOS'`)).rows[0].id;
  ai = async () => JSON.stringify({ paragraphs: [{ i: 0, text: '{{NOMBRE_VENDEDOR}} vende.' }], tags: [] });
  await call('POST', `/api/documentos/tags/models/${id}/restore`, 'admin', { version_id: (await pool.query('SELECT id FROM template_tag_versions WHERE template_id = $1 AND version_number = 1', [id])).rows[0].id });
  let { model } = await (await call('GET', `/api/documentos/tags/models/${id}`, 'admin')).json();
  // v3 = copy of v1 (both places tagged). Untag, then tag only the second place again
  ({ model } = await (await call('POST', `/api/documentos/tags/models/${id}/edit`, 'admin', { base_version_id: model.current.id, ops: [{ op: 'untag', key: 'NOMBRE_VENDEDOR' }] })).json());
  ({ model } = await (await call('POST', `/api/documentos/tags/models/${id}/edit`, 'admin', { base_version_id: model.current.id, ops: [{ op: 'tag', text: 'Firma: Juan Pérez', offset: 7, length: 10, key: 'NOMBRE_VENDEDOR' }] })).json());
  assert.deepEqual(model.current.tags[0].examples, ['Juan Pérez']);
  assert.deepEqual(await versionText(model.current.id), ['JUAN PÉREZ vende.', 'Firma: {{NOMBRE_VENDEDOR}}']);
});

test('two saves from the same base at the same time: one wins, the other gets 409', opts, async () => {
  const id = (await pool.query(`SELECT id FROM doc_templates WHERE name = 'DOS'`)).rows[0].id;
  const { model } = await (await call('GET', `/api/documentos/tags/models/${id}`, 'admin')).json();
  const body = (label) => ({ base_version_id: model.current.id, ops: [{ op: 'meta', key: 'NOMBRE_VENDEDOR', label }] });
  const res = await Promise.all([call('POST', `/api/documentos/tags/models/${id}/edit`, 'admin', body('A')), call('POST', `/api/documentos/tags/models/${id}/edit`, 'admin', body('B'))]);
  assert.deepEqual(res.map((r) => r.status).sort(), [201, 409]);
});

test('renaming a tag to a name that already exists is refused', opts, async () => {
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  const res = await call('POST', '/api/documentos/tags/models/1/edit', 'admin', { base_version_id: model.current.id, ops: [{ op: 'rename', from: 'NOMBRE_VENDEDOR', key: 'NOMBRE_COMPRADOR' }] });
  assert.equal(res.status, 400);
});

test('Llenar con IA reads into the tags of the version on screen', opts, async () => {
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  let prompt = '';
  ai = async (parts) => { prompt = parts[0]; return '{"NOMBRE_COMPRADOR": "ANA", "OTRA": "x"}'; };
  const res = await call('POST', '/api/documentos/tags/models/1/extract', 'admin', { version_id: model.versions[0].id, text: 'La compradora es Ana' });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).values, { NOMBRE_COMPRADOR: 'ANA' });
  assert.match(prompt, /NOMBRE_COMPRADOR/);
});

// ── Body edits: the admin changes the model's wording (by hand or with the AI) → a new version ──
const CUERPO = ['CONTRATO', 'El señor JUAN vende a PEDRO.', 'SEGUNDO: Cláusula vieja.', 'TERCERO: Se borra.'];
async function cuerpoV1() {
  makeDocx(path.join(TPL_DIR, 'cuerpo.docx'), CUERPO);
  await pool.query(`INSERT INTO doc_templates (name, file_path, file_name, category_id) VALUES ('CUERPO', 'cuerpo.docx', 'cuerpo.docx', 1)`);
  const id = (await pool.query(`SELECT id FROM doc_templates WHERE name = 'CUERPO'`)).rows[0].id;
  ai = async () => JSON.stringify({ paragraphs: [{ i: 1, text: 'El señor {{NOMBRE_VENDEDOR}} vende a {{NOMBRE_COMPRADOR}}.' }], tags: [] });
  const { model } = await (await call('POST', `/api/documentos/tags/models/${id}/ai`, 'admin')).json();
  return { id, model };
}

test('body edits: change a selection (tags included), rewrite, insert and delete paragraphs → new version with its tags', opts, async () => {
  const { id, model } = await cuerpoV1();
  const p1 = 'El señor {{NOMBRE_VENDEDOR}} vende a {{NOMBRE_COMPRADOR}}.';
  const sel = 'vende a {{NOMBRE_COMPRADOR}}';
  const res = await call('POST', `/api/documentos/tags/models/${id}/edit`, 'admin', {
    base_version_id: model.current.id,
    notes: 'Ahora es donación',
    ops: [
      { op: 'text', text: p1, offset: p1.indexOf(sel), length: sel.length, occurrence: 0, replacement: 'dona a {{nombre_donatario}}' },
      { op: 'para', i: 2, from: 'SEGUNDO: Cláusula vieja.', to: 'SEGUNDO: Cláusula nueva conforme a la Ley 108-05.' },
      { op: 'delete', i: 3, from: 'TERCERO: Se borra.' },
      { op: 'insert', after: 2, text: 'TERCERO: El precio es {{PRECIO_NUMEROS}}.' },
    ],
  });
  assert.equal(res.status, 201);
  const after = (await res.json()).model;
  assert.equal(after.current.version_number, 2);
  assert.equal(after.current.source, 'edit');
  assert.equal(after.status, 'pending');
  assert.deepEqual(await versionText(after.current.id), [
    'CONTRATO',
    'El señor {{NOMBRE_VENDEDOR}} dona a {{NOMBRE_DONATARIO}}.',
    'SEGUNDO: Cláusula nueva conforme a la Ley 108-05.',
    'TERCERO: El precio es {{PRECIO_NUMEROS}}.',
  ]);
  assert.deepEqual(after.current.tags.map((t) => [t.key, t.group, t.example]), [
    ['NOMBRE_VENDEDOR', 'VENDEDOR', 'JUAN'],
    ['NOMBRE_DONATARIO', 'DONATARIO', null],
    ['PRECIO_NUMEROS', 'DOCUMENTO', null],
  ]);
});

test('body edits are refused when stale, when a selection cuts a tag, or mixed with tag edits', opts, async () => {
  const id = (await pool.query(`SELECT id FROM doc_templates WHERE name = 'CUERPO'`)).rows[0].id;
  const { model } = await (await call('GET', `/api/documentos/tags/models/${id}`, 'admin')).json();
  const edit = (ops) => call('POST', `/api/documentos/tags/models/${id}/edit`, 'admin', { base_version_id: model.current.id, ops });
  const p1 = 'El señor {{NOMBRE_VENDEDOR}} dona a {{NOMBRE_DONATARIO}}.';
  assert.equal((await edit([{ op: 'para', i: 2, from: 'otro texto', to: 'x' }])).status, 400);
  assert.equal((await edit([{ op: 'text', text: p1, offset: 3, length: 12, occurrence: 0, replacement: 'x' }])).status, 400); // ends inside {{NOMBRE_VENDEDOR}}
  assert.equal((await edit([{ op: 'para', i: 0, from: 'CONTRATO', to: 'CONTRATO DE DONACIÓN' }, { op: 'meta', key: 'NOMBRE_VENDEDOR', label: 'x' }])).status, 400);
  assert.equal((await edit([{ op: 'para', i: 0, from: 'CONTRATO', to: 'CONTRATO DE {{}}' }])).status, 400);
  const { rows } = await pool.query('SELECT COUNT(*)::int n FROM template_tag_versions WHERE template_id = $1', [id]);
  assert.equal(rows[0].n, 2);
});

test('AI body edit only proposes: the changes come back to confirm, no version is created', opts, async () => {
  const id = (await pool.query(`SELECT id FROM doc_templates WHERE name = 'CUERPO'`)).rows[0].id;
  const { model } = await (await call('GET', `/api/documentos/tags/models/${id}`, 'admin')).json();
  let prompt = '';
  ai = async (p) => {
    prompt = p;
    return JSON.stringify([
      { op: 'replace', i: 1, text: 'El señor {{NOMBRE_VENDEDOR}}, de nacionalidad {{NACIONALIDAD_VENDEDOR}}, dona a {{NOMBRE_DONATARIO}}.' },
      { op: 'insert_after', i: 3, text: 'CUARTO: Las partes eligen domicilio en Santo Domingo.' },
      { op: 'delete', i: 99 },
    ]);
  };
  assert.equal((await call('POST', `/api/documentos/tags/models/${id}/ai-edit`, 'hengi', { instructions: 'x' })).status, 403);
  assert.equal((await call('POST', `/api/documentos/tags/models/${id}/ai-edit`, 'admin', { instructions: ' ' })).status, 400);
  const res = await call('POST', `/api/documentos/tags/models/${id}/ai-edit`, 'admin', { instructions: 'Agrega la nacionalidad del vendedor y elección de domicilio' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(prompt, /Agrega la nacionalidad/);
  assert.match(prompt, /\{\{NOMBRE_VENDEDOR\}\}/);
  assert.match(prompt, /etiquetas/i);
  assert.equal(body.base_version_id, model.current.id);
  assert.deepEqual(body.changes, [
    { op: 'para', i: 1, from: 'El señor {{NOMBRE_VENDEDOR}} dona a {{NOMBRE_DONATARIO}}.', to: 'El señor {{NOMBRE_VENDEDOR}}, de nacionalidad {{NACIONALIDAD_VENDEDOR}}, dona a {{NOMBRE_DONATARIO}}.', tags_added: ['NACIONALIDAD_VENDEDOR'], tags_removed: [] },
    { op: 'insert', after: 3, text: 'CUARTO: Las partes eligen domicilio en Santo Domingo.', tags_added: [], tags_removed: [] },
  ]);
  const { rows } = await pool.query('SELECT COUNT(*)::int n FROM template_tag_versions WHERE template_id = $1', [id]);
  assert.equal(rows[0].n, 2);
  // the accepted changes go back through /edit as one new version
  const saved = await call('POST', `/api/documentos/tags/models/${id}/edit`, 'admin', { base_version_id: body.base_version_id, ops: body.changes, notes: 'IA' });
  assert.equal(saved.status, 201);
  const v = (await saved.json()).model.current;
  assert.deepEqual((await versionText(v.id)).slice(1), [
    'El señor {{NOMBRE_VENDEDOR}}, de nacionalidad {{NACIONALIDAD_VENDEDOR}}, dona a {{NOMBRE_DONATARIO}}.',
    'SEGUNDO: Cláusula nueva conforme a la Ley 108-05.',
    'TERCERO: El precio es {{PRECIO_NUMEROS}}.',
    'CUARTO: Las partes eligen domicilio en Santo Domingo.',
  ]);
  assert.deepEqual(v.tags.map((t) => t.key), ['NOMBRE_VENDEDOR', 'NACIONALIDAD_VENDEDOR', 'NOMBRE_DONATARIO', 'PRECIO_NUMEROS']);
});
