const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-initial-'));
const TPL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-tpl-initial-'));
process.env.GURU_TEMPLATES_BASE_DIR = TPL_DIR;

const SEED = path.join(__dirname, '..', 'seeds', 'bot', 'modelos-iniciales.json');
const SNAPSHOT = path.join(__dirname, 'agent', 'catalog-snapshot.json');
const entries = JSON.parse(fs.readFileSync(SEED, 'utf8'));
const snapshot = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
const { run } = require('../scripts/tag-initial-models');

const quiet = () => {};
const SIN_FILE = 'CONTRATO EMPLEADO ASISTENTE LABORAL POR 3 MESES'; // no .docx on disk
const YA_ETIQUETADO = 'PODER CUOTA LITIS'; // already has a version

test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS template_tag_versions, doc_templates, doc_categories, bot_tool_log, bot_memory, business_info, tramites, invoices, service_catalog CASCADE');
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, digitacion_price NUMERIC, notarizacion_price NUMERIC, price_tiers JSONB, unit_type TEXT, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY)`);
  await runSqlFile('migrations/20261005_bot_agent.sql'); // service_catalog.template_id
  await pool.query(`CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, name TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  await runSqlFile('migrations/20261002_template_tags.sql');
  await pool.query(`INSERT INTO doc_categories (name) VALUES ('Modelos')`);
  // the real services from the snapshot (names only) and the 20 models by their exact names
  for (const s of snapshot.service_catalog) await pool.query('INSERT INTO service_catalog (name) VALUES ($1)', [s.name]);
  for (const [n, e] of entries.entries()) {
    const file = `m${n}.docx`;
    if (e.modelo !== SIN_FILE) fs.writeFileSync(path.join(TPL_DIR, file), 'x');
    // production has a trailing space in one name and an inactive duplicate of every model
    const name = e.modelo === 'DECLARACION JURADA DE BIENES E INGRESOS' ? `${e.modelo} ` : e.modelo;
    await pool.query('INSERT INTO doc_templates (name, file_path, file_name, category_id) VALUES ($1, $2, $2, 1)', [name, file]);
    await pool.query('INSERT INTO doc_templates (name, file_path, file_name, category_id, is_active) VALUES ($1, $2, $2, 1, FALSE)', [name, `old-${file}`]);
  }
  const { rows } = await pool.query('SELECT id FROM doc_templates WHERE name = $1 AND is_active', [YA_ETIQUETADO]);
  await pool.query(`INSERT INTO template_tag_versions (template_id, version_number, file_path, source) VALUES ($1, 1, '/tmp/x.docx', 'ai')`, [rows[0].id]);
});
test.after(async () => { await pool.end(); });

const links = async () => (await pool.query('SELECT name, template_id FROM service_catalog WHERE template_id IS NOT NULL ORDER BY name')).rows;
const versions = async () => (await pool.query('SELECT COUNT(*)::int n FROM template_tag_versions')).rows[0].n;
const idOf = async (name) => (await pool.query('SELECT id FROM doc_templates WHERE btrim(name) = $1 AND is_active', [name])).rows[0].id;

test('the seed has 20 distinct models and every service exists in the catalog snapshot', () => {
  assert.equal(entries.length, 20);
  const names = snapshot.service_catalog.filter((s) => s.active !== false).map((s) => s.name);
  const modelos = new Set();
  const servicios = new Set();
  for (const e of entries) {
    assert.equal(typeof e.modelo, 'string');
    assert.equal(e.modelo, e.modelo.trim());
    assert.ok(e.modelo.length > 3, e.modelo);
    assert.ok(!modelos.has(e.modelo), `modelo repetido: ${e.modelo}`);
    modelos.add(e.modelo);
    if (e.servicio === null) continue;
    assert.ok(names.includes(e.servicio), `servicio desconocido: ${e.servicio}`);
    assert.ok(!servicios.has(e.servicio), `servicio repetido: ${e.servicio}`);
    servicios.add(e.servicio);
  }
  assert.ok(servicios.size >= 15);
});

test('--dry-run resolves everything and writes nothing', async () => {
  const called = [];
  const r = await run({ dryRun: true, tagger: async (id) => { called.push(id); }, log: quiet });
  assert.equal(r.dryRun, true);
  assert.equal(r.models.length, 20);
  assert.equal(r.links.length, entries.filter((e) => e.servicio).length);
  assert.equal(r.toTag.length, 18); // one already tagged, one without a Word file
  assert.deepEqual(called, []);
  assert.deepEqual(await links(), []);
  assert.equal(await versions(), 1);
});

test('the real run links template_id as text and tags only the untagged models with a file', async () => {
  const called = [];
  const r = await run({ dryRun: false, tagger: async (id) => { called.push(id); }, log: quiet });
  assert.equal(r.dryRun, false);
  const got = await links();
  assert.equal(got.length, entries.filter((e) => e.servicio).length);
  for (const e of entries) {
    if (!e.servicio) continue;
    const row = got.find((x) => x.name === e.servicio);
    assert.ok(row, e.servicio);
    assert.equal(row.template_id, String(await idOf(e.modelo))); // the ACTIVE model, never the inactive duplicate
  }
  assert.equal(called.length, 18);
  assert.ok(!called.includes(await idOf(YA_ETIQUETADO)));
  assert.ok(!called.includes(await idOf(SIN_FILE)));
  assert.deepEqual(r.failed, []);
  assert.equal(r.skipped.map((s) => s.name).sort().join('|'), [SIN_FILE, YA_ETIQUETADO].sort().join('|'));
  // nothing approved
  assert.equal((await pool.query('SELECT COUNT(*)::int n FROM doc_templates WHERE approved_tag_version_id IS NOT NULL')).rows[0].n, 0);
  // the stub created no versions; a failing tagger is reported, not thrown
  assert.equal(await versions(), 1);
});

test('a tagger that fails on one model is reported and the others continue', async () => {
  const r = await run({ dryRun: false, tagger: async (id) => { if (id === await idOf('PROMESA DE VENTA')) throw new Error('AI_UNAVAILABLE'); }, log: quiet });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].name, 'PROMESA DE VENTA');
  assert.equal(r.tagged, 17);
});

test('a model or service that does not exist aborts before any write', async () => {
  const tmp = path.join(os.tmpdir(), `modelos-${Date.now()}.json`);
  fs.writeFileSync(tmp, JSON.stringify([{ modelo: 'MODELO QUE NO EXISTE', servicio: 'Poder Cuota Litis' }, ...entries.slice(1)]));
  await assert.rejects(run({ dryRun: false, file: tmp, tagger: async () => {}, log: quiet }), /MODELO QUE NO EXISTE/);
  fs.writeFileSync(tmp, JSON.stringify([{ modelo: 'PROMESA DE VENTA', servicio: 'Servicio Que No Existe' }, ...entries.slice(1)]));
  await assert.rejects(run({ dryRun: false, file: tmp, tagger: async () => {}, log: quiet }), /Servicio Que No Existe/);
  // an inactive-only model counts as missing
  await pool.query('UPDATE doc_templates SET is_active = FALSE WHERE name = $1', ['PROMESA DE VENTA']);
  await assert.rejects(run({ dryRun: false, tagger: async () => {}, log: quiet }), /PROMESA DE VENTA/);
  assert.deepEqual(await links(), []);
  assert.equal(await versions(), 1);
  fs.rmSync(tmp, { force: true });
});
