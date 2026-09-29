const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');

// The Word engine needs python-docx (installed in the Docker image). Skip if this machine lacks it.
const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-docs2-'));
const TPL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-tpl2-'));
process.env.GURU_TEMPLATES_BASE_DIR = TPL_DIR;

const aiDocs = require('../src/documentos/aiDocs');
const { listBlocks } = require('../src/documentos/docxText');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {}, ids = {};
let ai = async () => { throw new Error('unexpected AI call'); };
aiDocs.setGenerator((parts) => ai(parts));

const makeDocx = (file, paragraphs) =>
  spawnSync(PY, ['-c', `import sys, json\nfrom docx import Document\nd = Document()\nfor t in json.loads(sys.argv[2]): d.add_paragraph(t)\nd.save(sys.argv[1])`, file, JSON.stringify(paragraphs)]);

test.before(async () => {
  if (!hasDocx) return;
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Leandro','admin'), ('hengi','hengi@x.com','x','Hengi','digitador'), ('marleni','marleni@x.com','x','Marleni','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query('DROP TABLE IF EXISTS legal_profiles, portfolio_versions, portfolio_documents, clients, doc_template_variables, doc_variables, doc_templates, doc_categories CASCADE');
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, email TEXT, address TEXT, notes TEXT, user_id INT, source TEXT, assigned_to INT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, description TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  await pool.query(`CREATE TABLE doc_variables (id SERIAL PRIMARY KEY, tag TEXT, description TEXT, is_rol_dynamic BOOLEAN DEFAULT FALSE, rol_type TEXT)`);
  await pool.query(`CREATE TABLE doc_template_variables (id SERIAL PRIMARY KEY, template_id INT, variable_id INT, is_required BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0)`);
  makeDocx(path.join(TPL_DIR, 'venta.docx'), ['ACTO DE VENTA', 'Yo, JOSE ANTONIO PEREZ, cédula 001-0000000-1, vendo a ________ el vehículo.', 'PRIMERO: El precio es RD$100,000.']);
  makeDocx(path.join(TPL_DIR, 'poder.docx'), ['PODER', 'Comprador: {{NOMBRE_COMPRADOR}}, cédula {{DOCUMENTO IDENTIDAD_COMPRADOR}}.']);
  await pool.query(`INSERT INTO doc_templates (name, file_path, file_name) VALUES ('ACTO DE VENTA', 'venta.docx', 'venta.docx'), ('PODER', 'poder.docx', 'poder.docx')`);
  // DB tags: venta has vendedor/comprador fields; poder has none (fields come from the AI)
  await pool.query(`INSERT INTO doc_variables (tag, is_rol_dynamic, rol_type) VALUES
    ('NOMBRE_[ROL]', TRUE, 'VENDEDOR'), ('DOCUMENTO IDENTIDAD_[ROL]', TRUE, 'VENDEDOR'), ('NOMBRE_[ROL]', TRUE, 'COMPRADOR'), ('PRECIO_VENTA', FALSE, NULL)`);
  await pool.query(`INSERT INTO doc_template_variables (template_id, variable_id, sort_order) VALUES (1,1,1),(1,2,2),(1,3,3),(1,4,4)`);
  await pool.query(`INSERT INTO clients (name, phone) VALUES ('Juan Pérez', '18095550001')`);
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  await runSqlFile('migrations/20260929_legal_profiles.sql'); // idempotent
  await pool.query(`INSERT INTO legal_profiles (client_id, data) VALUES (1, '{"NOMBRE": "JUAN PÉREZ", "DOCUMENTO IDENTIDAD": "402-1111111-2"}')`);
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
test.after(async () => { if (server) server.close(); await pool.end(); });

const call = (method, p, who, body) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: body ? JSON.stringify(body) : undefined });
const fileText = async (versionId) => {
  const { rows } = await pool.query('SELECT file_path FROM portfolio_versions WHERE id = $1', [versionId]);
  return (await listBlocks(rows[0].file_path)).map((b) => b.text).join(' | ');
};

test('form fields come from the database tags, grouped by role, prefilled from the client profile', { skip: !hasDocx }, async () => {
  const res = await call('GET', '/api/documentos/fields?model_id=1&client_id=1&client_role=VENDEDOR', 'hengi');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.fields.map((f) => f.key), ['NOMBRE_VENDEDOR', 'DOCUMENTO IDENTIDAD_VENDEDOR', 'NOMBRE_COMPRADOR', 'PRECIO_VENTA']);
  assert.deepEqual(body.roles, ['VENDEDOR', 'COMPRADOR']);
  assert.equal(body.exact, false);
  assert.deepEqual(body.prefill, { NOMBRE_VENDEDOR: 'JUAN PÉREZ', 'DOCUMENTO IDENTIDAD_VENDEDOR': '402-1111111-2' });
});

test('without database tags, the AI proposes the fields; a tagged Word is filled exactly', { skip: !hasDocx }, async () => {
  ai = async () => JSON.stringify([{ key: 'NOMBRE_COMPRADOR', label: 'Nombre del comprador', group: 'COMPRADOR' }]);
  const body = await (await call('GET', '/api/documentos/fields?model_id=2', 'hengi')).json();
  assert.deepEqual(body.fields, [{ key: 'NOMBRE_COMPRADOR', label: 'Nombre del comprador', group: 'COMPRADOR' }]);
  assert.equal(body.exact, true);
});

test('the AI fills the form from attachments and text (only known fields)', { skip: !hasDocx }, async () => {
  let sawImage = false;
  ai = async (parts) => {
    sawImage = Array.isArray(parts) && parts.some((p) => p.inlineData && p.inlineData.mimeType === 'image/jpeg');
    return '```json\n{"NOMBRE_COMPRADOR": "MARÍA GÓMEZ", "INVENTADO": "x"}\n```';
  };
  const fd = new FormData();
  fd.append('model_id', '1');
  fd.append('client_id', '1');
  fd.append('text', 'La compradora es María Gómez');
  fd.append('files', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }), 'cedula.jpg');
  const res = await fetch(`${base}/api/documentos/fill/extract`, { method: 'POST', headers: { Authorization: `Bearer ${tok.hengi}` }, body: fd });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).values, { NOMBRE_COMPRADOR: 'MARÍA GÓMEZ' });
  assert.equal(sawImage, true);
});

test('generate from a model without tags: the AI places the data, v1 is saved, profile updated', { skip: !hasDocx }, async () => {
  ai = async () => JSON.stringify([{ i: 1, text: 'Yo, JUAN PÉREZ, cédula 402-1111111-2, vendo a MARÍA GÓMEZ el vehículo.' }]);
  const res = await call('POST', '/api/documentos/fill/generate', 'hengi', {
    model_id: 1, client_id: 1, client_role: 'VENDEDOR', title: 'Venta Corolla',
    values: { NOMBRE_VENDEDOR: 'JUAN PÉREZ', 'DOCUMENTO IDENTIDAD_VENDEDOR': '402-1111111-2', NOMBRE_COMPRADOR: 'MARÍA GÓMEZ', PROFESION_VENDEDOR: 'Chofer' },
  });
  assert.equal(res.status, 201);
  const { document, changes, exact } = await res.json();
  assert.equal(exact, false);
  assert.equal(document.versions[0].source, 'generated');
  assert.equal(changes.length, 1);
  assert.match(changes[0].before, /JOSE ANTONIO PEREZ/);
  assert.match(await fileText(document.versions[0].id), /vendo a MARÍA GÓMEZ/);
  ids.doc = document.id;
  ids.v1 = document.versions[0].id;
  const profile = (await (await call('GET', '/api/documentos/clients/1/profile', 'hengi')).json()).profile;
  assert.equal(profile.NOMBRE, 'JUAN PÉREZ');
});

test('a tagged Word is filled exactly without the AI', { skip: !hasDocx }, async () => {
  ai = async () => { throw new Error('the AI must not be used for tagged models'); };
  const res = await call('POST', '/api/documentos/fill/generate', 'hengi', {
    model_id: 2, client_id: 1, title: 'Poder María', values: { NOMBRE_COMPRADOR: 'MARÍA GÓMEZ', 'DOCUMENTO IDENTIDAD_COMPRADOR': '001-2222222-3' },
  });
  assert.equal(res.status, 201);
  const { document, exact } = await res.json();
  assert.equal(exact, true);
  assert.match(await fileText(document.versions[0].id), /Comprador: MARÍA GÓMEZ, cédula 001-2222222-3\./);
});

test('specific changes create a new version with the instructions as note', { skip: !hasDocx }, async () => {
  ai = async (parts) => {
    assert.match(String(parts), /penalidad/);
    return JSON.stringify([{ op: 'insert_after', i: 2, text: 'SEGUNDO: Penalidad del 10% por atraso.' }, { op: 'replace', i: 2, text: 'PRIMERO: El precio es RD$250,000.' }]);
  };
  const res = await call('POST', '/api/documentos/ai-edit', 'hengi', { version_id: ids.v1, instructions: 'Sube el precio a 250 mil y agrega una penalidad del 10%' });
  assert.equal(res.status, 201);
  const { document, changes } = await res.json();
  assert.deepEqual(document.versions.map((v) => v.version_number), [2, 1]);
  assert.equal(document.versions[0].source, 'ai_edit');
  assert.match(document.versions[0].notes, /penalidad/);
  assert.equal(changes.length, 2);
  assert.match(await fileText(document.versions[0].id), /RD\$250,000\. \| SEGUNDO: Penalidad del 10% por atraso\./);
});

test("nobody edits or generates from someone else's document", { skip: !hasDocx }, async () => {
  ai = async () => '[]';
  assert.equal((await call('POST', '/api/documentos/ai-edit', 'marleni', { version_id: ids.v1, instructions: 'cambia todo' })).status, 404);
  const res = await call('POST', '/api/documentos/ai-edit', 'hengi', { version_id: ids.v1, instructions: 'nada que ver' });
  assert.equal(res.status, 422);
  assert.equal((await res.json()).code, 'NO_CHANGES');
});
