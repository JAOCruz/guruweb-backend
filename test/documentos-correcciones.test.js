const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');

// Documentos · corrections and trash: anyone reports what is wrong (or could be better) in a model,
// the admin applies it in a new version or dismisses it, and a deleted model is hidden everywhere
// until the admin restores it.
const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-corr-'));
const TPL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-tpl-corr-'));
process.env.GURU_TEMPLATES_BASE_DIR = TPL_DIR;

const Tags = require('../src/documentos/templateTags');
const Catalog = require('../src/documentos/templatesCatalog');
const { listBlocks } = require('../src/documentos/docxText');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {}, users = {};

const makeDocx = (file, paragraphs) =>
  spawnSync(PY, ['-c', `import sys, json\nfrom docx import Document\nd = Document()\nfor t in json.loads(sys.argv[2]): d.add_paragraph(t)\nd.save(sys.argv[1])`, file, JSON.stringify(paragraphs)]);

const TEXT = ['PODER ESPECIAL', 'Yo, {{NOMBRE}}, otorgo poder amplio y suficiente.', 'Hecho en Santo Domingo.'];

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
  await pool.query('DROP TABLE IF EXISTS template_corrections, template_tag_versions, legal_profiles, portfolio_versions, portfolio_documents, clients, doc_template_variables, doc_variables, doc_templates, doc_categories CASCADE');
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, email TEXT, address TEXT, notes TEXT, user_id INT, source TEXT, assigned_to INT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, description TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  await pool.query(`CREATE TABLE doc_variables (id SERIAL PRIMARY KEY, tag TEXT, description TEXT, is_rol_dynamic BOOLEAN DEFAULT FALSE, rol_type TEXT)`);
  await pool.query(`CREATE TABLE doc_template_variables (id SERIAL PRIMARY KEY, template_id INT, variable_id INT, is_required BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0)`);
  makeDocx(path.join(TPL_DIR, 'poder.docx'), TEXT);
  await pool.query(`INSERT INTO doc_categories (name) VALUES ('Poderes')`);
  await pool.query(`INSERT INTO doc_templates (name, file_path, file_name, category_id) VALUES
    ('PODER ESPECIAL', 'poder.docx', 'poder.docx', 1), ('SIN ETIQUETAS', 'poder.docx', 'poder.docx', 1)`);
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  await runSqlFile('migrations/20261002_template_tags.sql');
  await runSqlFile('migrations/20261022_modelo_desde_documento.sql');
  await runSqlFile('migrations/20261025_modelos_papelera_correcciones.sql');
  await runSqlFile('migrations/20261025_modelos_papelera_correcciones.sql'); // idempotent
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
const notificationsOf = async (who) =>
  (await pool.query('SELECT type, title, message, link FROM notifications WHERE user_id = $1 ORDER BY id', [users[who]])).rows;
const opts = { skip: !hasDocx };

// model 1 with an approved v1
async function freshModel() {
  await pool.query(`DELETE FROM template_corrections; DELETE FROM template_tag_versions; DELETE FROM notifications;
    UPDATE doc_templates SET approved_tag_version_id = NULL, is_active = TRUE, deleted_at = NULL, deleted_by = NULL`);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'guru-v-')), 'v.docx');
  makeDocx(file, TEXT);
  const v = await Tags.createVersion({
    templateId: 1, localFile: file, tags: [{ key: 'NOMBRE', label: 'Nombre', group: 'GENERAL', example: 'ANA RUIZ', examples: ['ANA RUIZ'] }],
    source: 'ai', userId: users.admin,
  });
  await Tags.approve(v.id, users.admin);
  return v;
}

const report = (who, body, id = 1) => call('POST', `/api/documentos/tags/models/${id}/corrections`, who, body);

test('a digitador reports what is wrong in a paragraph; the admins are notified and see it', opts, async () => {
  const v = await freshModel();
  const res = await report('hengi', { paragraph_i: 1, excerpt: 'amplio y suficiente', comment: 'Falta decir que es por tiempo indefinido' });
  assert.equal(res.status, 201);
  const { correction } = await res.json();
  assert.equal(correction.status, 'pending');
  assert.equal(correction.version_id, v.id);

  for (const who of ['admin', 'admin2']) {
    const [n] = await notificationsOf(who);
    assert.match(n.title, /Corrección/);
    assert.match(n.message, /Hengi/);
    assert.match(n.message, /PODER ESPECIAL/);
    assert.equal(n.link, '/documents?tab=etiquetas&model=1');
  }
  assert.deepEqual(await notificationsOf('hengi'), []);

  const list = await (await call('GET', '/api/documentos/tags/models/1/corrections', 'admin')).json();
  assert.equal(list.corrections.length, 1);
  const c = list.corrections[0];
  assert.equal(c.created_by_name, 'Hengi');
  assert.equal(c.version_number, 1);
  assert.equal(c.excerpt, 'amplio y suficiente');
  assert.equal(c.paragraph_i, 1);
  assert.ok(c.created_at);

  // the summary counts pending corrections per model
  const { models } = await (await call('GET', '/api/documentos/tags/summary', 'admin')).json();
  assert.equal(models.find((m) => m.id === 1).pending_corrections, 1);
});

test('a digitador only sees their own reports; a report needs a comment and an approved model', opts, async () => {
  await freshModel();
  await report('hengi', { comment: 'El título debería decir PODER ESPECIAL DE REPRESENTACIÓN' });
  await report('otro', { comment: 'Hay una coma de más en el segundo párrafo' });
  const mine = await (await call('GET', '/api/documentos/tags/models/1/corrections', 'hengi')).json();
  assert.deepEqual(mine.corrections.map((c) => c.created_by_name), ['Hengi']);

  assert.equal((await report('hengi', { comment: ' ' })).status, 400);
  assert.equal((await report('hengi', { comment: 'algo está mal aquí' }, 2)).status, 404); // no approved version
  assert.equal((await report('hengi', { comment: 'algo está mal aquí' }, 99)).status, 404);
});

test('the admin applies a correction with a text edit: it records who, when and the version', opts, async () => {
  const v = await freshModel();
  const { correction } = await (await report('hengi', { paragraph_i: 1, comment: 'Agregar por tiempo indefinido' })).json();
  const res = await call('POST', '/api/documentos/tags/models/1/edit', 'admin', {
    base_version_id: v.id, correction_id: correction.id, notes: 'Agregué el plazo',
    ops: [{ op: 'para', i: 1, from: TEXT[1], to: 'Yo, {{NOMBRE}}, otorgo poder amplio y suficiente por tiempo indefinido.' }],
  });
  assert.equal(res.status, 201);
  const { model } = await res.json();
  const v2 = model.versions[0];
  assert.equal(v2.version_number, 2);
  // the version tells which correction produced it
  assert.deepEqual(v2.corrections.map((c) => c.id), [correction.id]);

  const { corrections: [c] } = await (await call('GET', '/api/documentos/tags/models/1/corrections', 'admin')).json();
  assert.equal(c.status, 'applied');
  assert.equal(c.resolved_by_name, 'Leandro');
  assert.ok(c.resolved_at);
  assert.equal(c.resulting_version_number, 2);
  // the reporter learns it was applied
  const [n] = await notificationsOf('hengi');
  assert.match(n.title, /aplicada/);
  assert.match(n.message, /v2/);

  // an applied correction cannot be applied or dismissed again
  const again = await call('POST', `/api/documentos/tags/corrections/${correction.id}/dismiss`, 'admin', { note: 'x' });
  assert.equal(again.status, 409);
});

test('a correction of another model is refused and nothing is saved', opts, async () => {
  const v = await freshModel();
  const { rows: [other] } = await pool.query(
    `INSERT INTO template_corrections (template_id, comment, created_by) VALUES (2, 'otra', $1) RETURNING id`, [users.hengi]);
  const res = await call('POST', '/api/documentos/tags/models/1/edit', 'admin', {
    base_version_id: v.id, correction_id: other.id,
    ops: [{ op: 'para', i: 2, from: TEXT[2], to: 'Hecho en Santiago.' }],
  });
  assert.equal(res.status, 400);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM template_tag_versions WHERE template_id = 1')).rows[0].n, 1);
});

test('only an admin dismisses a correction, with a reason the reporter gets', opts, async () => {
  await freshModel();
  const { correction } = await (await report('hengi', { comment: 'Cambiar Santo Domingo por Santiago' })).json();
  assert.equal((await call('POST', `/api/documentos/tags/corrections/${correction.id}/dismiss`, 'otro', { note: 'no' })).status, 403);
  const res = await call('POST', `/api/documentos/tags/corrections/${correction.id}/dismiss`, 'admin', { note: 'La oficina está en Santo Domingo' });
  assert.equal(res.status, 200);
  const { corrections: [c] } = await (await call('GET', '/api/documentos/tags/models/1/corrections', 'hengi')).json();
  assert.equal(c.status, 'dismissed');
  assert.equal(c.resolution_note, 'La oficina está en Santo Domingo');
  assert.equal(c.resolved_by_name, 'Leandro');
  const [n] = await notificationsOf('hengi');
  assert.match(n.title, /descartada/);
  assert.match(n.message, /La oficina está en Santo Domingo/);
});

test('a deleted model is hidden everywhere until the admin restores it, versions intact', opts, async () => {
  const v = await freshModel();
  assert.equal((await call('DELETE', '/api/documentos/tags/models/1', 'hengi')).status, 403);
  const res = await call('DELETE', '/api/documentos/tags/models/1', 'admin');
  assert.equal(res.status, 200);

  assert.equal((await call('GET', '/api/documentos/tags/models/1', 'hengi')).status, 404);
  assert.equal((await call('GET', '/api/documentos/tags/models/1', 'admin')).status, 404);
  assert.equal((await report('hengi', { comment: 'algo está mal aquí' })).status, 404);
  const { models } = await (await call('GET', '/api/documentos/tags/summary', 'admin')).json();
  assert.ok(!models.some((m) => m.id === 1));
  assert.ok(!(await Catalog.listModels()).some((m) => m.id === 1)); // the selection list forgets it right away
  assert.equal((await call('DELETE', '/api/documentos/tags/models/1', 'admin')).status, 404); // already in the trash

  const trash = await (await call('GET', '/api/documentos/tags/deleted', 'admin')).json();
  assert.equal(trash.models.length, 1);
  assert.equal(trash.models[0].name, 'PODER ESPECIAL');
  assert.equal(trash.models[0].deleted_by_name, 'Leandro');
  assert.ok(trash.models[0].deleted_at);
  assert.equal((await call('GET', '/api/documentos/tags/deleted', 'hengi')).status, 403);

  assert.equal((await call('POST', '/api/documentos/tags/models/1/undelete', 'hengi')).status, 403);
  const back = await call('POST', '/api/documentos/tags/models/1/undelete', 'admin');
  assert.equal(back.status, 200);
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'hengi')).json();
  assert.equal(model.approved.id, v.id);
  assert.ok((await Catalog.listModels()).some((m) => m.id === 1));
  assert.equal((await (await call('GET', '/api/documentos/tags/deleted', 'admin')).json()).models.length, 0);
  assert.equal((await call('POST', '/api/documentos/tags/models/1/undelete', 'admin')).status, 404); // not in the trash
});

test('the version history keeps who saved each version and when', opts, async () => {
  await freshModel();
  const { model } = await (await call('GET', '/api/documentos/tags/models/1', 'admin')).json();
  const [v1] = model.versions;
  assert.equal(v1.created_by_name, 'Leandro');
  assert.ok(v1.created_at);
  assert.deepEqual(v1.corrections, []);
  // listBlocks still reads the stored file
  assert.equal((await listBlocks((await Tags.getVersion(v1.id)).file_path)).length, 3);
});
