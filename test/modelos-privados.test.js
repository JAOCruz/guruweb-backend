const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const cookieParser = require('cookie-parser');

// Documentos · modelos privados: los sube cualquier usuario, los usan su dueño y el admin sin aprobación,
// y nadie más los ve (ni otro usuario, ni el bot, ni el sitio, ni las rutas antiguas) hasta publicarlos.
const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-priv-'));
const TPL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-tpl-priv-'));
process.env.GURU_TEMPLATES_BASE_DIR = TPL_DIR;

const aiDocs = require('../src/documentos/aiDocs');
const Tags = require('../src/documentos/templateTags');
const { listModels, listModelsFor, resolveModelPath, clearCache } = require('../src/documentos/templatesCatalog');
const { generateToken } = require('../src/middleware/auth');

let server, base, tok = {}, users = {}, userRows = {};
const TAGGED = JSON.stringify({
  paragraphs: [{ i: 1, text: 'Yo, {{NOMBRE_PODERDANTE}}, otorgo poder.' }],
  tags: [{ key: 'NOMBRE_PODERDANTE', label: 'Nombre', group: 'PODERDANTE' }],
});
aiDocs.setGenerator(async () => TAGGED);

const makeDocx = (file, paragraphs, author) =>
  spawnSync(PY, ['-c', `import sys, json\nfrom docx import Document\nd = Document()\nfor t in json.loads(sys.argv[2]): d.add_paragraph(t)\nif sys.argv[3]: d.core_properties.author = sys.argv[3]\nd.save(sys.argv[1])`, file, JSON.stringify(paragraphs), author || '']);
const docxBuffer = (author) => {
  const f = path.join(TPL_DIR, `up-${Date.now()}.tmp.docx`);
  makeDocx(f, ['PODER', 'Yo, ANA RUIZ, otorgo poder.'], author);
  const b = fs.readFileSync(f); fs.rmSync(f); return b;
};

const call = (method, p, who, body) =>
  fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: body ? JSON.stringify(body) : undefined });
const upload = (who, { name = 'Mi poder', category = 1, buffer = docxBuffer(), filename = 'mi.docx' } = {}) => {
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  if (name) form.append('name', name);
  if (category) form.append('category_id', String(category));
  return fetch(`${base}/api/documentos/tags/models`, { method: 'POST', headers: { Authorization: `Bearer ${tok[who]}` }, body: form });
};
// un modelo privado de hengi, ya etiquetado
const ownModel = async (name = 'Mi poder') => {
  const r = await upload('hengi', { name });
  assert.equal(r.status, 201);
  const { model } = await r.json();
  const t = await call('POST', `/api/documentos/tags/models/${model.id}/ai`, 'hengi');
  assert.equal(t.status, 201);
  return (await t.json()).model;
};
const names = async (p, who) => {
  const r = await call('GET', p, who);
  assert.equal(r.status, 200);
  return JSON.stringify(await r.json());
};

test.before(async () => {
  if (!hasDocx) return;
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('admin','admin@x.com','x','Leandro','admin'), ('hengi','hengi@x.com','x','Hengi','digitador'),
    ('otro','otro@x.com','x','Otro','digitador'), ('aux','aux@x.com','x','Aux','auxiliar'), ('borrar','borrar@x.com','x','Borrar','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query('DROP TABLE IF EXISTS notifications');
  await runSqlFile('migrations/20250714_add_notifications.sql');
  await pool.query('DROP TABLE IF EXISTS template_corrections, template_tag_versions, legal_profiles, portfolio_versions, portfolio_documents, clients, doc_template_variables, doc_variables, doc_templates, doc_categories CASCADE');
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, email TEXT, address TEXT, notes TEXT, user_id INT, source TEXT, assigned_to INT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT, slug TEXT, parent_id INT, sort_order INT DEFAULT 0, description TEXT, icon TEXT)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, description TEXT, file_path TEXT NOT NULL, file_name TEXT NOT NULL, doc_type TEXT NOT NULL DEFAULT 'docx', category_id INT, is_active BOOLEAN DEFAULT TRUE, required_roles JSONB DEFAULT '[]', estimated_price_min INT, estimated_price_max INT, sort_order INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_variables (id SERIAL PRIMARY KEY, tag TEXT, description TEXT, is_rol_dynamic BOOLEAN DEFAULT FALSE, rol_type TEXT)`);
  await pool.query(`CREATE TABLE doc_template_variables (id SERIAL PRIMARY KEY, template_id INT, variable_id INT, is_required BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0)`);
  await pool.query(`INSERT INTO doc_categories (name, slug) VALUES ('Poderes', 'poderes')`);
  makeDocx(path.join(TPL_DIR, 'oficial.docx'), ['PODER OFICIAL', 'Yo, ANA RUIZ, otorgo poder.']);
  await pool.query(`INSERT INTO doc_templates (name, slug, file_path, file_name, category_id) VALUES ('MODELO OFICIAL', 'modelo-oficial', 'oficial.docx', 'oficial.docx', 1)`);
  await pool.query(`INSERT INTO clients (name, phone) VALUES ('Juan Pérez', '18095550001')`);
  await runSqlFile('migrations/20260929_portfolio.sql');
  await pool.query('CREATE TABLE IF NOT EXISTS invoices (id SERIAL PRIMARY KEY, status TEXT)');
  await pool.query('DROP TABLE IF EXISTS business_info');
  await pool.query('CREATE TABLE business_info (clave TEXT PRIMARY KEY, valor JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())');
  await runSqlFile('migrations/20261006_bot_fase2.sql');
  await runSqlFile('migrations/20260929_legal_profiles.sql');
  await runSqlFile('migrations/20261002_template_tags.sql');
  await runSqlFile('migrations/20261022_modelo_desde_documento.sql');
  await runSqlFile('migrations/20261025_modelos_papelera_correcciones.sql');
  await runSqlFile('migrations/20261104_modelos_privados.sql');
  await runSqlFile('migrations/20261104_modelos_privados.sql'); // idempotente
  for (const u of (await pool.query('SELECT id, username, email, role FROM users')).rows) {
    tok[u.username] = generateToken(u);
    users[u.username] = u.id;
    userRows[u.username] = u;
  }
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/documentos/tags', require('../src/routes/documentosTags'));
  app.use('/api/documentos', require('../src/routes/documentos'));
  app.use('/api/documents', require('../src/routes/documents'));
  app.use('/api/docgen', require('../src/routes/docGen'));
  app.use('/api/public', require('../src/routes/publicModels'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { if (server) server.close(); await pool.end(); });
test.beforeEach(async () => {
  if (!hasDocx) return;
  await pool.query(`DELETE FROM portfolio_documents; DELETE FROM notifications; DELETE FROM template_tag_versions; DELETE FROM doc_templates WHERE is_private OR name <> 'MODELO OFICIAL'; UPDATE doc_templates SET approved_tag_version_id = NULL`);
  clearCache();
});
const t = (name, fn) => test(name, { skip: !hasDocx && 'python-docx no instalado' }, fn);

// ── Datos y acceso ──
t('la base rechaza un modelo privado publicado', async () => {
  const m = await ownModel();
  const { rows } = await pool.query('SELECT id FROM template_tag_versions WHERE template_id = $1', [m.id]);
  await assert.rejects(pool.query('UPDATE doc_templates SET approved_tag_version_id = $1 WHERE id = $2', [rows[0].id, m.id]), /doc_templates_private_not_published/);
});

t('accessFor: privado solo dueño y admin; no privado admin y empleado', () => {
  const priv = { is_private: true, created_by: 7 };
  const pub = { is_private: false, created_by: 7 };
  assert.equal(Tags.accessFor({ id: 7, role: 'digitador' }, priv), 'owner');
  assert.equal(Tags.accessFor({ id: 1, role: 'admin' }, priv), 'admin');
  assert.equal(Tags.accessFor({ id: 8, role: 'auxiliar' }, priv), null);
  assert.equal(Tags.accessFor({ id: 7, role: 'digitador' }, pub), 'employee');
  assert.equal(Tags.accessFor({ id: 1, role: 'admin' }, pub), 'admin');
});

t('borrar al dueño deja el modelo privado', async () => {
  const r = await upload('hengi');
  const { model } = await r.json();
  await pool.query('UPDATE doc_templates SET created_by = $1 WHERE id = $2', [users.borrar, model.id]);
  await pool.query('DELETE FROM users WHERE id = $1', [users.borrar]).catch(() => {});
  const { rows } = await pool.query('SELECT is_private FROM doc_templates WHERE id = $1', [model.id]);
  assert.equal(rows[0].is_private, true);
  assert.equal(JSON.stringify(await listModels()).includes('Mi poder'), false);
});

t('resolveModelPath acepta la carpeta de subidas y no permite salir de ella', () => {
  const dir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'template_uploads');
  assert.equal(resolveModelPath(path.join(dir, 'a.docx')), path.join(dir, 'a.docx'));
  assert.equal(resolveModelPath(path.join(dir, '..', 'portfolio', 'a.docx')), null);
  assert.equal(resolveModelPath('../../etc/passwd'), null);
  assert.equal(resolveModelPath('oficial.docx'), path.join(path.resolve(TPL_DIR), 'oficial.docx'));
});

// ── Subir ──
t('un auxiliar sube un modelo: queda privado, con su archivo en el volumen', async () => {
  const r = await upload('aux', { name: 'Modelo del auxiliar' });
  assert.equal(r.status, 201);
  const { model } = await r.json();
  assert.equal(model.is_private, true);
  assert.equal(model.can_manage, true);
  const { rows } = await pool.query('SELECT file_path, created_by, is_private FROM doc_templates WHERE id = $1', [model.id]);
  assert.equal(rows[0].created_by, users.aux);
  assert.ok(rows[0].file_path.startsWith(path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'template_uploads')));
  assert.ok(fs.existsSync(rows[0].file_path));
});

t('el Word guardado queda sin el autor original', async () => {
  const r = await upload('hengi', { buffer: docxBuffer('ANA RUIZ') });
  const { model } = await r.json();
  const { rows } = await pool.query('SELECT file_path FROM doc_templates WHERE id = $1', [model.id]);
  const text = spawnSync(PY, ['-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nprint(z.read("docProps/core.xml").decode())', rows[0].file_path]).stdout.toString();
  assert.equal(text.includes('ANA RUIZ'), false);
});

t('un archivo falso, sin nombre o con categoría inexistente: 400 sin guardar nada', async () => {
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM doc_templates')).rows[0].n;
  const dir = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'template_uploads');
  const filesBefore = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  assert.equal((await upload('hengi', { buffer: Buffer.from('no soy un word') })).status, 400);
  assert.equal((await upload('hengi', { buffer: Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(50)]) })).status, 400);
  assert.equal((await upload('hengi', { filename: 'x.pdf' })).status, 400);
  assert.equal((await upload('hengi', { name: '' })).status, 400);
  assert.equal((await upload('hengi', { category: 9999 })).status, 400);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM doc_templates')).rows[0].n, before);
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, filesBefore);
});

t('un zip que no es Word o un Word sin texto: 400 sin guardar nada', async () => {
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM doc_templates')).rows[0].n;
  const zip = path.join(TPL_DIR, 'falso.zip');
  spawnSync(PY, ['-c', 'import sys, zipfile\nz = zipfile.ZipFile(sys.argv[1], "w")\nz.writestr("xl/workbook.xml", "<a/>")\nz.close()', zip]);
  assert.equal((await upload('hengi', { buffer: fs.readFileSync(zip) })).status, 400);
  const blank = path.join(TPL_DIR, 'blanco.tmp.docx');
  makeDocx(blank, []);
  assert.equal((await upload('hengi', { buffer: fs.readFileSync(blank) })).status, 400);
  fs.rmSync(zip); fs.rmSync(blank);
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM doc_templates')).rows[0].n, before);
});

// ── Biblioteca ──
t('la Biblioteca muestra el privado a su dueño y al admin, no a otros', async () => {
  const m = await ownModel();
  const lista = async (who) => (await (await call('GET', '/api/documentos/models', who)).json()).models;
  const mine = (await lista('hengi')).find((x) => x.id === m.id);
  assert.equal(mine.is_private, true);
  assert.equal(mine.can_manage, true);
  assert.equal(mine.tag_status, 'pending');
  assert.equal(mine.file_path, undefined);
  const forAdmin = (await lista('admin')).find((x) => x.id === m.id);
  assert.equal(forAdmin.owner_name, 'Hengi');
  assert.equal((await lista('otro')).some((x) => x.id === m.id), false);
  assert.equal((await lista('aux')).some((x) => x.id === m.id), false);
  const oficial = (await lista('otro')).find((x) => x.name === 'MODELO OFICIAL');
  assert.equal(oficial.is_private, false);
  assert.equal(oficial.can_manage, false);
});

t('otro usuario recibe 404 en cada ruta de un modelo privado', async () => {
  const m = await ownModel();
  const { rows: [v] } = await pool.query('SELECT id FROM template_tag_versions WHERE template_id = $1', [m.id]);
  const P = `/api/documentos/tags/models/${m.id}`;
  for (const who of ['otro', 'aux']) {
    for (const [method, p, body] of [
      ['GET', P],
      ['GET', `/api/documentos/models/${m.id}/file`],
      ['GET', `/api/documentos/tags/versions/${v.id}/file`],
      ['POST', `${P}/fill`, { client_id: 1, values: {} }],
      ['POST', `${P}/ai`],
      ['POST', `${P}/edit`, { ops: [] }],
      ['POST', `${P}/ai-edit`, { instructions: 'cambia esto' }],
      ['POST', `${P}/restore`, { version_id: v.id }],
      ['POST', `${P}/corrections`, { comment: 'está mal' }],
      ['POST', `${P}/request-publish`],
      ['DELETE', P],
    ]) {
      const r = await call(method, p, who, body);
      assert.equal(r.status, 404, `${who} ${method} ${p}`);
    }
  }
  const asModel = await call('POST', '/api/documentos/fill/generate', 'otro', { model_id: m.id, values: {}, client_id: 1 });
  assert.equal(asModel.status, 404);
  const doc = await call('POST', `${P}/fill`, 'hengi', { client_id: 1, values: { NOMBRE_PODERDANTE: 'JUAN' } });
  assert.equal(doc.status, 201);
});

t('el dueño llena con un cliente sin publicar y edita su modelo; el admin también', async () => {
  const m = await ownModel();
  const P = `/api/documentos/tags/models/${m.id}`;
  const filled = await call('POST', `${P}/fill`, 'hengi', { client_id: 1, values: { NOMBRE_PODERDANTE: 'JUAN PÉREZ' } });
  assert.equal(filled.status, 201);
  assert.equal((await call('POST', `${P}/fill`, 'admin', { client_id: 1, values: { NOMBRE_PODERDANTE: 'JUAN PÉREZ' } })).status, 201);
  assert.equal((await call('GET', P, 'hengi')).status, 200);
  assert.equal((await call('POST', `${P}/ai`, 'hengi')).status, 201);
  const corr = await call('POST', `${P}/corrections`, 'hengi', { comment: 'está mal' });
  assert.equal(corr.status, 400);
});

t('el dueño borra su privado; un empleado no puede gestionar un modelo no privado', async () => {
  const m = await ownModel();
  assert.equal((await call('DELETE', `/api/documentos/tags/models/${m.id}`, 'hengi')).status, 200);
  assert.equal((await call('POST', `/api/documentos/tags/models/${m.id}/undelete`, 'hengi')).status, 403);
  const { rows: [of] } = await pool.query(`SELECT id FROM doc_templates WHERE name = 'MODELO OFICIAL'`);
  assert.equal((await call('POST', `/api/documentos/tags/models/${of.id}/ai`, 'hengi')).status, 403);
  assert.equal((await call('DELETE', `/api/documentos/tags/models/${of.id}`, 'hengi')).status, 403);
});

t('un documento nuevo no puede apuntar al modelo privado de otro', async () => {
  const m = await ownModel();
  const form = new FormData();
  form.append('file', new Blob([docxBuffer()]), 'x.docx');
  form.append('title', 'x');
  form.append('template_id', String(m.id));
  const r = await fetch(`${base}/api/documentos/documents`, { method: 'POST', headers: { Authorization: `Bearer ${tok.otro}` }, body: form });
  assert.equal(r.status, 400);
});

t('al editar o restaurar, la respuesta al dueño nunca le ofrece publicar', async () => {
  const m = await ownModel();
  const P = `/api/documentos/tags/models/${m.id}`;
  assert.equal(m.can_publish, false);
  const { rows: [v] } = await pool.query('SELECT id FROM template_tag_versions WHERE template_id = $1', [m.id]);
  const restored = await call('POST', `${P}/restore`, 'hengi', { version_id: v.id });
  assert.equal(restored.status, 201);
  assert.equal((await restored.json()).model.can_publish, false);
  const edited = await call('POST', `${P}/edit`, 'hengi', { ops: [{ op: 'label', key: 'NOMBRE_PODERDANTE', label: 'Otro nombre' }] });
  const body = await edited.json();
  if (edited.status === 201) assert.equal(body.model.can_publish, false);
  const asAdmin = await (await call('GET', P, 'admin')).json();
  assert.equal(asAdmin.model.can_publish, true);
});

t('en la papelera el dueño no puede tocar su modelo ni bajar sus versiones', async () => {
  const m = await ownModel();
  const P = `/api/documentos/tags/models/${m.id}`;
  const { rows: [v] } = await pool.query('SELECT id FROM template_tag_versions WHERE template_id = $1', [m.id]);
  assert.equal((await call('DELETE', P, 'hengi')).status, 200);
  const before = (await pool.query('SELECT COUNT(*)::int AS n FROM template_tag_versions WHERE template_id = $1', [m.id])).rows[0].n;
  for (const [method, p] of [['POST', `${P}/ai`], ['POST', `${P}/request-publish`], ['DELETE', P], ['GET', `/api/documentos/tags/versions/${v.id}/file`]]) {
    assert.equal((await call(method, p, 'hengi')).status, 404, `${method} ${p}`);
  }
  assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM template_tag_versions WHERE template_id = $1', [m.id])).rows[0].n, before);
});

t('publicar avisa una sola vez al dueño aunque guardó una versión desde un documento', async () => {
  const m = await ownModel();
  const { rows: [v] } = await pool.query('SELECT id FROM template_tag_versions WHERE template_id = $1', [m.id]);
  const doc = await (await call('POST', `/api/documentos/tags/models/${m.id}/fill`, 'hengi', { client_id: 1, values: { NOMBRE_PODERDANTE: 'JUAN' } })).json();
  await pool.query(`UPDATE template_tag_versions SET source = 'client', origin_document_id = $1 WHERE id = $2`, [doc.document.id, v.id]);
  assert.equal((await call('POST', `/api/documentos/tags/versions/${v.id}/approve`, 'admin')).status, 200);
  const { rows } = await pool.query('SELECT title FROM notifications WHERE user_id = $1', [users.hengi]);
  assert.equal(rows.length, 1);
  assert.match(rows[0].title, /Modelo publicado/);
});

// ── Publicar ──
t('pedir publicar sin etiquetas: 400', async () => {
  const { model } = await (await upload('hengi')).json();
  assert.equal((await call('POST', `/api/documentos/tags/models/${model.id}/request-publish`, 'hengi')).status, 400);
});

t('pedir, publicar: sale a todos, el dueño pierde la edición y recibe aviso', async () => {
  const m = await ownModel();
  const P = `/api/documentos/tags/models/${m.id}`;
  const q = await call('POST', `${P}/request-publish`, 'hengi');
  assert.equal(q.status, 200);
  const adminNote = await pool.query('SELECT message, link FROM notifications WHERE user_id = $1', [users.admin]);
  assert.equal(adminNote.rows.length, 1);
  assert.match(adminNote.rows[0].link, /tab=etiquetas/);
  const sum = await (await call('GET', '/api/documentos/tags/summary', 'admin')).json();
  const inQueue = sum.models.find((x) => x.id === m.id);
  assert.equal(inQueue.is_private, true);
  assert.equal(inQueue.owner_name, 'Hengi');

  const { rows: [v] } = await pool.query('SELECT id FROM template_tag_versions WHERE template_id = $1 ORDER BY id DESC LIMIT 1', [m.id]);
  assert.equal((await call('POST', `/api/documentos/tags/versions/${v.id}/approve`, 'hengi')).status, 403);
  assert.equal((await call('POST', `/api/documentos/tags/versions/${v.id}/approve`, 'admin')).status, 200);
  const { rows: [row] } = await pool.query('SELECT is_private, publish_requested_at, approved_tag_version_id FROM doc_templates WHERE id = $1', [m.id]);
  assert.equal(row.is_private, false);
  assert.equal(row.publish_requested_at, null);
  assert.equal(row.approved_tag_version_id, v.id);

  const otro = (await (await call('GET', '/api/documentos/models', 'otro')).json()).models.find((x) => x.id === m.id);
  assert.equal(otro.tag_status, 'approved');
  assert.equal((await call('POST', `${P}/fill`, 'aux', { client_id: 1, values: {} })).status, 201);
  assert.equal((await call('POST', `${P}/ai`, 'hengi')).status, 403);
  assert.ok((await call('GET', P, 'hengi')).ok);
  assert.equal((await (await call('GET', P, 'hengi')).json()).model.versions, undefined);
  const note = await pool.query('SELECT message FROM notifications WHERE user_id = $1', [users.hengi]);
  assert.match(note.rows.at(-1).message, /publicad/i);
  assert.ok(await names('/api/public/models', 'otro').then((s) => s.includes('Mi poder')));
});

t('el etiquetado masivo no toca privados y la cola solo trae los pedidos', async () => {
  const m = await ownModel();
  assert.equal((await Tags.listStatuses()).some((x) => x.id === m.id), false);
  const sum = await (await call('GET', '/api/documentos/tags/summary', 'admin')).json();
  assert.equal(sum.models.some((x) => x.id === m.id), false);
});

// ── Fugas en rutas antiguas, bot y sitio ──
t('rutas antiguas, sitio, bot y flujo de WhatsApp no muestran privados', async () => {
  const m = await ownModel('PRIVADO SECRETO');
  for (const who of ['otro', 'admin', 'hengi']) {
    assert.equal((await names('/api/documents/index', who)).includes('PRIVADO SECRETO'), false, `index ${who}`);
    assert.equal((await names('/api/docgen/categories', who)).includes('PRIVADO SECRETO'), false, `categories ${who}`);
    assert.equal((await names('/api/docgen/templates', who)).includes('PRIVADO SECRETO'), false, `templates ${who}`);
    assert.equal((await call('GET', `/api/docgen/templates/${m.id}`, who)).status, 404, `template ${who}`);
  }
  assert.equal((await names('/api/public/models', 'otro')).includes('PRIVADO SECRETO'), false);
  const { approvedByName } = require('../src/agent/tools/documents');
  if (approvedByName) assert.equal(await approvedByName('PRIVADO SECRETO'), null);
  const flow = require('../src/conversation/flows/docGen');
  assert.ok(flow.getTemplatesByCategory && flow.getTemplateDetail, 'el flujo expone sus consultas');
  await pool.query(`UPDATE doc_templates SET category_id = 1 WHERE id = $1`, [m.id]);
  assert.equal(JSON.stringify(await flow.getTemplatesByCategory('poderes')).includes('PRIVADO SECRETO'), false);
  assert.equal(await flow.getTemplateDetail(m.id), undefined);
  assert.equal(JSON.stringify(await listModels()).includes('PRIVADO SECRETO'), false);
  assert.equal(JSON.stringify(await listModelsFor(userRows.otro)).includes('PRIVADO SECRETO'), false);
  assert.equal(JSON.stringify(await listModelsFor(userRows.hengi)).includes('PRIVADO SECRETO'), true);
});

t('importar la biblioteca no desactiva ni reutiliza privados', async () => {
  const m = await ownModel('MODELO OFICIAL 2');
  const { importLibrary } = require('../scripts/importar-biblioteca');
  await pool.query(`CREATE TABLE IF NOT EXISTS service_catalog (id SERIAL PRIMARY KEY, name TEXT, active BOOLEAN DEFAULT TRUE, template_id TEXT)`);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-lib-'));
  await importLibrary({ baseDir: empty, apply: false, log: () => {} }).catch(() => {});
  const { rows } = await pool.query('SELECT is_active FROM doc_templates WHERE id = $1', [m.id]);
  assert.equal(rows[0].is_active, true);
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'importar-biblioteca.js'), 'utf8');
  assert.match(src, /FROM doc_templates WHERE is_private = FALSE/);
  const reseed = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'reseed-doc-templates.js'), 'utf8');
  assert.match(reseed, /SET is_active = false WHERE is_private = FALSE/);
  assert.match(reseed, /slug = \$1 AND category_id = \$2 AND is_private = FALSE/);
});
