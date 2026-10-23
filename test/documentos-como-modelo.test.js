const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');

// Documentos · a personalized client document becomes a new version of its model: the AI puts tags
// back in place of the client's data, the admin approves it, and from then on everyone fills it.
const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-asmodel-'));
const TPL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-tpl-asmodel-'));
process.env.GURU_TEMPLATES_BASE_DIR = TPL_DIR;

const aiDocs = require('../src/documentos/aiDocs');
const { listBlocks } = require('../src/documentos/docxText');
const Portfolio = require('../src/documentos/portfolio');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {}, users = {};
let ai = async () => { throw new Error('unexpected AI call'); };
aiDocs.setGenerator((parts) => ai(parts));

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const makeDocx = (file, paragraphs) =>
  spawnSync(PY, ['-c', `import sys, json\nfrom docx import Document\nd = Document()\nfor t in json.loads(sys.argv[2]): d.add_paragraph(t)\nd.save(sys.argv[1])`, file, JSON.stringify(paragraphs)]);

// The client's document: the model's text with Juan Pérez's data and a new clause written for him
const CLIENT_DOC = [
  'PODER ESPECIAL',
  'Yo, JUAN PÉREZ, cédula 402-1111111-2, otorgo poder a LUIS DIAZ.',
  'SEGUNDO: El apoderado podrá cobrar en mi nombre ante cualquier banco.',
  'Hecho en Santo Domingo, República Dominicana, por un soltero.',
];
const TAGGED = JSON.stringify({
  paragraphs: [{ i: 1, text: 'Yo, {{NOMBRE_PODERDANTE}}, cédula {{DOCUMENTO IDENTIDAD_PODERDANTE}}, otorgo poder a {{NOMBRE_APODERADO}}.' }],
  tags: [
    { key: 'NOMBRE_PODERDANTE', label: 'Nombre de Juan Pérez', group: 'PODERDANTE' }, // a label with the client's name
    { key: 'DOCUMENTO IDENTIDAD_PODERDANTE', label: 'Cédula del poderdante', group: 'PODERDANTE' },
    { key: 'NOMBRE_APODERADO', label: 'Nombre del apoderado', group: 'APODERADO' },
  ],
});

// Word extras a digitador's file can carry: header text, a comment, the author, a tracked deletion, a mailto link
const EXTRAS = `
import sys, json, copy
from docx import Document
from docx.oxml import parse_xml
from docx.oxml.ns import nsdecls
spec = json.loads(sys.argv[2])
d = Document(sys.argv[1])
W = nsdecls('w')
if spec.get('header'): d.sections[0].header.paragraphs[0].text = spec['header']
if spec.get('author'): d.core_properties.author = spec['author']; d.core_properties.last_modified_by = spec['author']
p = d.paragraphs[1]
if spec.get('comment'): d.add_comment(p.runs[0], text=spec['comment'], author=spec.get('author') or 'x')
if spec.get('deleted'):
    p._p.append(parse_xml(f'<w:del {W} w:id="91" w:author="x" w:date="2026-01-01T00:00:00Z"><w:r><w:delText>{spec["deleted"]}</w:delText></w:r></w:del>'))
if spec.get('mailto'):
    rid = d.part.relate_to('mailto:' + spec['mailto'], 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', is_external=True)
    p._p.append(parse_xml(f'<w:hyperlink {W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="{rid}"><w:r><w:t xml:space="preserve"> escribir a {spec["mailto"]}</w:t></w:r></w:hyperlink>'))
d.save(sys.argv[1])
`;
// every text inside the .docx (all its XML parts), to prove nothing of the client is left anywhere
const zipText = (file) => spawnSync(PY, ['-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nprint("\\n".join(z.read(n).decode("utf-8", "ignore") for n in z.namelist()))', file]).stdout.toString();

async function clientDocument({ owner = 'hengi', paragraphs = CLIENT_DOC, templateId = 1, mime = DOCX, extras = null } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guru-doc-')), mime === DOCX ? 'doc.docx' : 'doc.pdf');
  if (mime === DOCX) makeDocx(file, paragraphs);
  else fs.writeFileSync(file, '%PDF-1.4 x');
  if (extras) {
    const r = spawnSync(PY, ['-c', EXTRAS, file, JSON.stringify(extras)]);
    assert.equal(r.status, 0, r.stderr.toString());
  }
  return Portfolio.createDocument({
    clientId: 1, title: 'PODER — Juan Pérez', templateId, userId: users[owner],
    file: { path: file, name: path.basename(file), mime, size: fs.statSync(file).size, source: 'generated' },
  });
}

test.before(async () => {
  if (!hasDocx) return;
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Leandro','admin'), ('admin2','admin2@x.com','x','Socio','admin'),
    ('hengi','hengi@x.com','x','Hengi','digitador'), ('otro','otro@x.com','x','Otro','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query('DROP TABLE IF EXISTS notifications');
  await runSqlFile('migrations/20250714_add_notifications.sql');
  await pool.query('DROP TABLE IF EXISTS template_tag_versions, legal_profiles, portfolio_versions, portfolio_documents, clients, doc_template_variables, doc_variables, doc_templates, doc_categories CASCADE');
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, email TEXT, address TEXT, notes TEXT, user_id INT, source TEXT, assigned_to INT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, description TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  await pool.query(`CREATE TABLE doc_variables (id SERIAL PRIMARY KEY, tag TEXT, description TEXT, is_rol_dynamic BOOLEAN DEFAULT FALSE, rol_type TEXT)`);
  await pool.query(`CREATE TABLE doc_template_variables (id SERIAL PRIMARY KEY, template_id INT, variable_id INT, is_required BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0)`);
  makeDocx(path.join(TPL_DIR, 'poder.docx'), ['PODER ESPECIAL', 'Yo, ANA RUIZ, cédula 001-2222222-3, otorgo poder a LUIS DIAZ.', 'Hecho en Santo Domingo.']);
  await pool.query(`INSERT INTO doc_categories (name) VALUES ('Poderes')`);
  await pool.query(`INSERT INTO doc_templates (name, file_path, file_name, category_id) VALUES ('PODER ESPECIAL', 'poder.docx', 'poder.docx', 1)`);
  await pool.query(`INSERT INTO clients (name, phone) VALUES ('Juan Pérez', '18095550001')`);
  await runSqlFile('migrations/20260929_portfolio.sql');
  await pool.query('CREATE TABLE IF NOT EXISTS invoices (id SERIAL PRIMARY KEY, status TEXT)');
  await pool.query('DROP TABLE IF EXISTS business_info');
  await pool.query('CREATE TABLE business_info (clave TEXT PRIMARY KEY, valor JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  await runSqlFile('migrations/20261002_template_tags.sql');
  await runSqlFile('migrations/20261022_modelo_desde_documento.sql');
  await runSqlFile('migrations/20261022_modelo_desde_documento.sql'); // idempotent
  await pool.query(`INSERT INTO legal_profiles (client_id, data) VALUES (1, '{"NOMBRE": "JUAN PÉREZ", "DOCUMENTO IDENTIDAD": "402-1111111-2", "NACIONALIDAD": "DOMINICANA", "ESTADO CIVIL": "SOLTERO"}')`);
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) {
    tok[u.username] = generateToken(u);
    users[u.username] = u.id;
  }
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/documentos/tags', require('../src/routes/documentosTags'));
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
const notificationsOf = async (who) =>
  (await pool.query('SELECT type, title, message, link FROM notifications WHERE user_id = $1 ORDER BY id', [users[who]])).rows;
const clearVersions = () => pool.query('DELETE FROM template_tag_versions; DELETE FROM notifications; UPDATE doc_templates SET approved_tag_version_id = NULL');
const opts = { skip: !hasDocx };

test('a digitador saves their document as a new pending version of the model; the admins are notified', opts, async () => {
  await clearVersions();
  const docId = await clientDocument();
  ai = async () => TAGGED;
  const res = await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'hengi');
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.version.version_number, 1);
  assert.deepEqual(body.client_data_left, []);

  const { rows: [v] } = await pool.query('SELECT * FROM template_tag_versions WHERE id = $1', [body.version.id]);
  assert.equal(v.template_id, 1);
  assert.equal(v.source, 'client');
  assert.equal(v.created_by, users.hengi);
  assert.equal(v.origin_document_id, docId);
  assert.equal(v.approved_at, null);
  // the client's data became tags; the new clause stays as written
  assert.deepEqual(await versionText(v.id), [
    'PODER ESPECIAL',
    'Yo, {{NOMBRE_PODERDANTE}}, cédula {{DOCUMENTO IDENTIDAD_PODERDANTE}}, otorgo poder a {{NOMBRE_APODERADO}}.',
    'SEGUNDO: El apoderado podrá cobrar en mi nombre ante cualquier banco.',
    'Hecho en Santo Domingo, República Dominicana, por un soltero.',
  ]);
  // a label never carries the client's data
  assert.ok(v.tags.every((t) => !/juan|pérez/i.test(t.label)), JSON.stringify(v.tags));
  // pending: employees cannot use it yet
  assert.equal((await call('GET', '/api/documentos/tags/models/1', 'otro')).status, 404);

  // every admin gets a notification that opens the model in the review; the author does not
  for (const who of ['admin', 'admin2']) {
    const [n] = await notificationsOf(who);
    assert.equal(n.type, 'approval');
    assert.match(n.title, /por aprobar/);
    assert.match(n.message, /Hengi/);
    assert.match(n.message, /PODER ESPECIAL/);
    assert.doesNotMatch(n.message, /Juan|JUAN/);
    assert.equal(n.link, '/documents?tab=etiquetas&model=1');
  }
  assert.deepEqual(await notificationsOf('hengi'), []);
});

test('the admin sees where the version came from; once approved, employees fill it without that origin', opts, async () => {
  await clearVersions();
  const docId = await clientDocument();
  ai = async () => TAGGED;
  const { version } = await (await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'hengi')).json();

  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  const v = model.versions[0];
  assert.equal(v.source, 'client');
  assert.equal(v.created_by_name, 'Hengi');
  assert.equal(v.origin_client, 'Juan Pérez');
  assert.equal(v.origin_title, 'PODER — Juan Pérez');

  const ok = await call('POST', `/api/documentos/tags/versions/${version.id}/approve`, 'admin');
  assert.equal(ok.status, 200);
  const res = await call('GET', '/api/documentos/tags/models/1', 'otro');
  assert.equal(res.status, 200);
  const seen = JSON.stringify((await res.json()).model);
  assert.doesNotMatch(seen, /Juan|JUAN|402-1111111-2|origin_/);
  assert.doesNotMatch(seen, /"skipped"/);

  // the author learns it was approved
  const [n] = await notificationsOf('hengi');
  assert.match(n.title, /aprobada/);
  assert.equal(n.link, '/documents');
});

test('client data the AI left untagged is reported by paragraph and in the notes, never copied into them', opts, async () => {
  await clearVersions();
  const docId = await clientDocument();
  ai = async () => JSON.stringify({
    paragraphs: [{ i: 1, text: 'Yo, {{NOMBRE_PODERDANTE}}, cédula 402-1111111-2, otorgo poder a {{NOMBRE_APODERADO}}.' }],
    tags: [{ key: 'NOMBRE_PODERDANTE', group: 'PODERDANTE' }, { key: 'NOMBRE_APODERADO', group: 'APODERADO' }],
  });
  const res = await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'hengi');
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.deepEqual(body.client_data_left, [2]);
  const { rows: [v] } = await pool.query('SELECT notes FROM template_tag_versions WHERE id = $1', [body.version.id]);
  assert.match(v.notes, /datos del cliente/);
  assert.match(v.notes, /párrafo 2/);
  assert.doesNotMatch(v.notes, /402|Juan|JUAN/);
});

test('only someone who can see the document can use it, and only a Word made from a model', opts, async () => {
  await clearVersions();
  ai = async () => TAGGED;
  const docId = await clientDocument();
  assert.equal((await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'otro')).status, 404);
  assert.equal((await call('POST', '/api/documentos/tags/documents/9999/as-model', 'hengi')).status, 404);
  const loose = await clientDocument({ templateId: null });
  assert.equal((await call('POST', `/api/documentos/tags/documents/${loose}/as-model`, 'hengi')).status, 400);
  const pdf = await clientDocument({ mime: 'application/pdf' });
  assert.equal((await call('POST', `/api/documentos/tags/documents/${pdf}/as-model`, 'hengi')).status, 400);
  const { rows } = await pool.query('SELECT COUNT(*)::int n FROM template_tag_versions');
  assert.equal(rows[0].n, 0);
});

test('an admin can do it too: the other admins are notified, the author is not', opts, async () => {
  await clearVersions();
  ai = async () => TAGGED;
  const docId = await clientDocument({ owner: 'admin' });
  assert.equal((await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'admin')).status, 201);
  assert.deepEqual(await notificationsOf('admin'), []);
  assert.equal((await notificationsOf('admin2')).length, 1);
});

test('when the AI cannot tag anything: 422, no version and no notification', opts, async () => {
  await clearVersions();
  ai = async () => JSON.stringify({ paragraphs: [{ i: 1, text: 'Otro texto {{X}}.' }], tags: [] });
  const docId = await clientDocument();
  assert.equal((await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'hengi')).status, 422);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM template_tag_versions')).rows[0].n, 0);
  assert.deepEqual(await notificationsOf('admin'), []);
});

test('employees never get tag examples: an admin who tags a leftover cédula does not publish it', opts, async () => {
  await clearVersions();
  const docId = await clientDocument();
  ai = async () => JSON.stringify({
    paragraphs: [{ i: 1, text: 'Yo, {{NOMBRE_PODERDANTE}}, cédula 402-1111111-2, otorgo poder a {{NOMBRE_APODERADO}}.' }],
    tags: [{ key: 'NOMBRE_PODERDANTE', group: 'PODERDANTE' }, { key: 'NOMBRE_APODERADO', group: 'APODERADO' }],
  });
  const { version } = await (await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'hengi')).json();
  const text = 'Yo, {{NOMBRE_PODERDANTE}}, cédula 402-1111111-2, otorgo poder a {{NOMBRE_APODERADO}}.';
  const edit = await call('POST', '/api/documentos/tags/models/1/edit', 'admin', {
    base_version_id: version.id,
    ops: [{ op: 'tag', text, offset: text.indexOf('402'), length: 13, occurrence: 0, key: 'DOCUMENTO IDENTIDAD_PODERDANTE' }],
  });
  assert.ok(edit.ok, await edit.clone().text());
  const fixed = (await edit.json()).model.current;
  assert.equal(fixed.source, 'edit');
  assert.equal((await call('POST', `/api/documentos/tags/versions/${fixed.id}/approve`, 'admin')).status, 200);
  const seen = JSON.stringify((await (await call('GET', '/api/documentos/tags/models/1', 'otro')).json()).model);
  assert.doesNotMatch(seen, /402-1111111-2|"example"|"examples"/);
  // the fixed version keeps where it came from, and its author hears it was approved
  const { rows: [row] } = await pool.query('SELECT origin_document_id FROM template_tag_versions WHERE id = $1', [fixed.id]);
  assert.equal(row.origin_document_id, docId);
  assert.match((await notificationsOf('hengi'))[0].title, /aprobada/);
});

test('a value the AI replaced (another person) left elsewhere in the text is reported too', opts, async () => {
  await clearVersions();
  const docId = await clientDocument({ paragraphs: [...CLIENT_DOC.slice(0, 3), 'LUIS DIAZ firma como apoderado.'] });
  ai = async () => TAGGED;
  const body = await (await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'hengi')).json();
  assert.deepEqual(body.client_data_left, [4]);
});

test('the saved Word keeps nothing of the client outside the text: no comments, author, deleted text or links', opts, async () => {
  await clearVersions();
  const docId = await clientDocument({ extras: { author: 'Juan Pérez', comment: 'llamar a Juan Pérez', deleted: 'JUAN PÉREZ 402-1111111-2', mailto: 'juanperez@correo.com' } });
  let seenByAi = '';
  ai = async (parts) => {
    seenByAi = JSON.stringify(parts);
    return JSON.stringify({
      paragraphs: [{ i: 1, text: 'Yo, {{NOMBRE_PODERDANTE}}, cédula {{DOCUMENTO IDENTIDAD_PODERDANTE}}, otorgo poder a {{NOMBRE_APODERADO}}. escribir a {{CORREO_PODERDANTE}}' }],
      tags: [{ key: 'NOMBRE_PODERDANTE' }, { key: 'DOCUMENTO IDENTIDAD_PODERDANTE' }, { key: 'NOMBRE_APODERADO' }, { key: 'CORREO_PODERDANTE' }],
    });
  };
  const res = await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'hengi');
  assert.equal(res.status, 201, await res.clone().text());
  const body = await res.json();
  const { rows: [v] } = await pool.query('SELECT file_path FROM template_tag_versions WHERE id = $1', [body.version.id]);
  const all = zipText(v.file_path);
  assert.doesNotMatch(all, /Juan|JUAN|juanperez|402-1111111-2/);
  // the link became plain text, so the AI saw it and tagged it; the deleted text and the comment never reached it
  assert.match(seenByAi, /juanperez@correo\.com/);
  assert.doesNotMatch(seenByAi, /llamar a/);
  assert.deepEqual(body.client_data_left, []);
});

test('client data in a header or footer stops it: the Word must be fixed first', opts, async () => {
  await clearVersions();
  const docId = await clientDocument({ extras: { header: 'Expediente de Juan Pérez' } });
  ai = async () => TAGGED;
  const res = await call('POST', `/api/documentos/tags/documents/${docId}/as-model`, 'hengi');
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.code, 'CLIENT_DATA_OUTSIDE_TEXT');
  assert.match(body.error, /encabezado/);
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM template_tag_versions')).rows[0].n, 0);
});
