// Biblioteca de modelos de Leandro (2026-10-27): reemplaza a la vieja, sus etiquetas se aprueban tal cual,
// y lo que no trae etiquetas (o perdió alguna) queda para que Leandro lo revise, con aviso.
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-bib-'));
const LIB = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-bib-lib-'));
process.env.GURU_TEMPLATES_BASE_DIR = LIB;

const Tags = require('../src/documentos/templateTags');
const { importLibrary } = require('../scripts/importar-biblioteca');

const makeDocx = (file, paragraphs) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  spawnSync(PY, ['-c', `import sys, json\nfrom docx import Document\nd = Document()\nfor t in json.loads(sys.argv[2]): d.add_paragraph(t)\nd.save(sys.argv[1])`, file, JSON.stringify(paragraphs)]);
};
const quiet = () => {};
let ids = {}, leandro, socio;

test.before(async () => {
  if (!hasDocx) return;
  await resetDb();
  await pool.query(`INSERT INTO users (username, email, password_hash, name, role) VALUES
    ('leandro','l@x.com','x','Leandro','admin'), ('socio','s@x.com','x','Socio','admin'), ('hengi','h@x.com','x','Hengi','digitador')`);
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS notifications');
  await runSqlFile('migrations/20250714_add_notifications.sql');
  await pool.query('DROP TABLE IF EXISTS template_corrections, template_tag_versions, portfolio_versions, portfolio_documents, clients, doc_templates, doc_categories, service_catalog CASCADE');
  await pool.query(`CREATE TABLE clients (id SERIAL PRIMARY KEY, name TEXT, phone TEXT UNIQUE, user_id INT, assigned_to INT, created_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT, slug TEXT, parent_id INT, sort_order INT DEFAULT 0)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, slug TEXT, description TEXT, file_path TEXT, file_name TEXT,
    doc_type TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE, sort_order INT DEFAULT 0, updated_at TIMESTAMPTZ)`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, active BOOLEAN DEFAULT TRUE, template_id TEXT)`);
  await runSqlFile('migrations/20260929_portfolio.sql');
  await runSqlFile('migrations/20261002_template_tags.sql');
  await runSqlFile('migrations/20261022_modelo_desde_documento.sql');
  await runSqlFile('migrations/20261025_modelos_papelera_correcciones.sql');
  await pool.query(`CREATE TABLE IF NOT EXISTS service_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS category_id INT, ADD COLUMN IF NOT EXISTS digitacion_price NUMERIC,
    ADD COLUMN IF NOT EXISTS unit_type TEXT, ADD COLUMN IF NOT EXISTS por_confirmar BOOLEAN, ADD COLUMN IF NOT EXISTS notarizacion TEXT,
    ADD COLUMN IF NOT EXISTS foja_tipo TEXT, ADD COLUMN IF NOT EXISTS fojas INT, ADD COLUMN IF NOT EXISTS descripcion TEXT,
    ADD COLUMN IF NOT EXISTS reglas TEXT, ADD COLUMN IF NOT EXISTS alias TEXT[]`);
  await runSqlFile('migrations/20261028_biblioteca_leandro.sql');
  for (const u of (await pool.query('SELECT id, username FROM users')).rows) ids[u.username] = u.id;
  leandro = ids.leandro; socio = ids.socio;

  // la biblioteca vieja (lo que hay en el sistema)
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-bib-old-'));
  makeDocx(path.join(old, 'poder.docx'), ['PODER', 'Yo, {{NOMBRE_PODERDANTE}}, cédula {{CEDULA_PODERDANTE}}, otorgo poder.']);
  await pool.query(`INSERT INTO doc_templates (name, file_path, file_name) VALUES
    ('PODER ESPECIAL', 'PODERES/PODER ESPECIAL.docx', 'PODER ESPECIAL.docx'),
    ('INSTANCIA DE JUAN PEREZ', 'INSTANCIAS/INSTANCIA DE JUAN PEREZ.docx', 'x.docx'),
    ('EN PAPELERA', 'EN PAPELERA.docx', 'EN PAPELERA.docx'),
    ('ACTO DE NOTIFICACION DE SENTENCIA', 'viejo/a.docx', 'a.docx'),
    ('ACTO DE NOTIFICACION DE SENTENCIA', 'viejo/b.docx', 'b.docx'),
    ('PODER CUOTA LITIS', 'viejo/cuota.docx', 'cuota.docx')`);
  const v = await Tags.createVersion({ templateId: 1, localFile: path.join(old, 'poder.docx'),
    tags: [{ key: 'NOMBRE_PODERDANTE', label: 'Nombre', group: 'PODERDANTE' }, { key: 'CEDULA_PODERDANTE', label: 'Cédula', group: 'PODERDANTE' }],
    source: 'ai', userId: leandro });
  await Tags.approve(v.id, leandro);
  await pool.query(`UPDATE doc_templates SET deleted_at = NOW(), is_active = FALSE WHERE name = 'EN PAPELERA'`);
  await pool.query(`INSERT INTO service_catalog (name, template_id) VALUES ('Instancia - Solicitud', '2'), ('Poder', '1'),
    ('Notificación', '5'), ('Poder Cuota Litis', '6')`);

  // la biblioteca nueva de Leandro
  makeDocx(path.join(LIB, 'CONTRATOS CIVILES', 'PODERES', 'PODER ESPECIAL.docx'),
    ['PODER ESPECIAL', 'Yo, {{NOMBRE_PODERDANTE}}, otorgo poder a {{NOMBRE_APODERADO}}.', 'Ante mí, {{NOMBRE_NOTARIO}}, notario.']);
  makeDocx(path.join(LIB, 'CONTRATOS CIVILES', 'ACUERDOS', 'ACUERDO RECIBO DE DESCARGO.docx'), ['ACUERDO', 'Las partes acuerdan…']);
  makeDocx(path.join(LIB, 'NOTIFICACIONES', 'ACTO DE NOTIFICACION DE SENTENCIA.docx'), ['ACTO', 'A requerimiento de {{NOMBRE_REQUIRENTE}}, {{NOMBRE_TESTIGO 1}}.']);
  makeDocx(path.join(LIB, 'EN PAPELERA.docx'), ['{{NOMBRE}}']);
  makeDocx(path.join(LIB, 'CONTRATOS CIVILES', 'PODERES', 'PODER ESPECIAL DE CUOTA LITIS.docx'), ['Yo, {{NOMBRE_PODERDANTE}}.']);
});
test.after(async () => { await pool.end(); });

const count = async (sql) => (await pool.query(sql)).rows[0].n;

test('modo prueba: dice lo que haría y no cambia nada', { skip: !hasDocx }, async () => {
  const before = await count('SELECT COUNT(*)::int n FROM template_tag_versions');
  const s = await importLibrary({ log: quiet });
  assert.equal(s.modelos, 5);
  assert.equal(s.actualizados, 2);
  assert.equal(s.nuevos, 2);
  assert.equal(s.desactivados, 3); // el caso viejo, el duplicado sin servicio y el poder cuota litis viejo
  assert.deepEqual(s.en_papelera, ['EN PAPELERA']);
  assert.deepEqual(s.sin_etiquetas, [path.join('CONTRATOS CIVILES', 'ACUERDOS', 'ACUERDO RECIBO DE DESCARGO.docx')]);
  assert.deepEqual(s.servicios_sin_modelo, ['Instancia - Solicitud']);
  assert.deepEqual(s.servicios_religados, ['Poder Cuota Litis → PODER ESPECIAL DE CUOTA LITIS']);
  assert.equal(await count('SELECT COUNT(*)::int n FROM template_tag_versions'), before);
  assert.equal(await count('SELECT COUNT(*)::int n FROM doc_templates'), 6);
  assert.equal(await count('SELECT COUNT(*)::int n FROM notifications'), 0);
  assert.equal(await count(`SELECT COUNT(*)::int n FROM service_catalog WHERE name = 'Poder Cuota Litis' AND template_id = '6'`), 1);
});

test('--aplicar: reemplaza, aprueba las etiquetas de Leandro y deja para revisar lo que falta, con aviso', { skip: !hasDocx }, async () => {
  const s = await importLibrary({ apply: true, log: quiet });
  assert.equal(s.versiones, 3); // el de la papelera no se toca

  // el poder conserva su id (y su enlace con el catálogo) y queda con la versión de la biblioteca aprobada
  const poder = (await pool.query(`SELECT * FROM doc_templates WHERE id = 1`)).rows[0];
  assert.equal(poder.file_path, path.join('CONTRATOS CIVILES', 'PODERES', 'PODER ESPECIAL.docx'));
  assert.equal(poder.is_active, true);
  const m = await Tags.getModel(1, { admin: true });
  assert.equal(m.approved.source, 'library');
  assert.equal(m.approved.version_number, 2);
  assert.deepEqual(m.approved.tags.map((t) => t.key), ['NOMBRE_PODERDANTE', 'NOMBRE_APODERADO', 'NOMBRE_NOTARIO']);
  assert.equal(m.approved.tags[2].group, 'NOTARIO');
  const v = (await pool.query('SELECT approved_by, created_by FROM template_tag_versions WHERE id = $1', [m.approved.id])).rows[0];
  assert.deepEqual(v, { approved_by: leandro, created_by: leandro });

  // la etiqueta que se perdió queda como corrección pendiente
  const corr = (await pool.query(`SELECT template_id, comment FROM template_corrections WHERE status = 'pending' ORDER BY id`)).rows;
  assert.equal(corr.length, 2);
  assert.match(corr.find((c) => c.template_id === 1).comment, /CEDULA_PODERDANTE/);

  // el acuerdo sin etiquetas se crea y queda para revisar
  const acuerdo = (await pool.query(`SELECT t.id, t.is_active, c.name AS cat FROM doc_templates t JOIN doc_categories c ON c.id = t.category_id
    WHERE t.name = 'ACUERDO RECIBO DE DESCARGO'`)).rows[0];
  assert.deepEqual([acuerdo.is_active, acuerdo.cat], [true, 'ACUERDOS']);
  assert.match(corr.find((c) => c.template_id === acuerdo.id).comment, /sin etiquetas/);
  assert.equal((await Tags.getModel(acuerdo.id, { admin: true })).current, null);

  // aviso a cada admin activo (no a los digitadores), que abre el modelo
  const notes = (await pool.query(`SELECT user_id, title, link FROM notifications ORDER BY id`)).rows;
  assert.equal(notes.length, 4);
  assert.ok(notes.every((n) => [leandro, socio].includes(n.user_id) && n.title === '🏷️ Modelo para revisar'));
  assert.ok(notes.some((n) => n.link === `/documents?tab=etiquetas&model=${acuerdo.id}`));

  // lo viejo se desactiva y lo de la papelera se queda ahí
  const rest = (await pool.query(`SELECT name, is_active, deleted_at IS NOT NULL AS papelera FROM doc_templates WHERE id IN (2, 3) ORDER BY id`)).rows;
  assert.deepEqual(rest, [{ name: 'INSTANCIA DE JUAN PEREZ', is_active: false, papelera: false }, { name: 'EN PAPELERA', is_active: false, papelera: true }]);

  // de los duplicados se queda el ligado al servicio; el servicio del modelo viejo pasa al equivalente nuevo
  const dup = (await pool.query(`SELECT id, is_active FROM doc_templates WHERE id IN (4, 5) ORDER BY id`)).rows;
  assert.deepEqual(dup, [{ id: 4, is_active: false }, { id: 5, is_active: true }]);
  const cuota = (await pool.query(`SELECT id FROM doc_templates WHERE name = 'PODER ESPECIAL DE CUOTA LITIS'`)).rows[0].id;
  const svc = Object.fromEntries((await pool.query('SELECT name, template_id FROM service_catalog')).rows.map((r) => [r.name, r.template_id]));
  assert.equal(svc['Notificación'], '5');
  assert.equal(svc['Poder Cuota Litis'], String(cuota));
  assert.equal(svc['Instancia - Solicitud'], '2');
});

test('repetirla no duplica versiones, correcciones ni avisos', { skip: !hasDocx }, async () => {
  const s = await importLibrary({ apply: true, log: quiet });
  assert.deepEqual([s.versiones, s.saltados], [0, 3], JSON.stringify(s));
  assert.equal(s.nuevos, 0);
  assert.equal(await count('SELECT COUNT(*)::int n FROM template_corrections'), 2);
  assert.equal(await count('SELECT COUNT(*)::int n FROM notifications'), 4);
  assert.equal(await count('SELECT COUNT(*)::int n FROM doc_templates'), 8);
});

test('la migración agrega la demanda como documentación motivada por foja', { skip: !hasDocx }, async () => {
  const d = (await pool.query(`SELECT foja_tipo, fojas, notarizacion, reglas, alias FROM service_catalog WHERE name = 'Demanda'`)).rows;
  assert.equal(d.length, 1);
  assert.equal(d[0].foja_tipo, 'carta_motivada');
  assert.doesNotMatch(d[0].reglas, /RD\$|\d{3}/, 'los montos viven en las columnas de precio');
  assert.ok(d[0].alias.includes('demanda laboral'));
  await runSqlFile('migrations/20261028_biblioteca_leandro.sql');
  assert.equal(await count(`SELECT COUNT(*)::int n FROM service_catalog WHERE name = 'Demanda'`), 1);
});
