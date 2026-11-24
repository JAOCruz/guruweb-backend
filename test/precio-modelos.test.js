// Precio de los modelos: fojas × tarifa del tipo de foja (tamaño del archivo; motivada por carpeta o categoría).
const { pool, runSqlFile } = require('./helpers/db'); // primero: apunta la base a la de pruebas
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { clasificarModelo, fojasDeModelo, precioDeModelo } = require('../src/documentos/templateFojas');
const rates = require('../src/models/pricingRates');

test.beforeEach(() => rates._reset());

test('contrato tamaño legal de 2 fojas: legal simple, 2 × 250 = 500', () => {
  const r = clasificarModelo({ h: 20160, pages: 2, words: 600 }, 'CONTRATOS CIVILES ACUERDOS');
  assert.deepEqual(r, { fojas: 2, foja_tipo: 'legal_simple', estimadas: false });
  assert.equal(precioDeModelo(r), 500);
});

test('acto de alguacil en carta: carta motivada, 2 × 300 = 600', () => {
  const r = clasificarModelo({ h: 15840, pages: 2 }, 'NOTIFICACIONES');
  assert.equal(r.foja_tipo, 'carta_motivada');
  assert.equal(precioDeModelo(r), 600);
});

test('A4 cuenta como carta; una demanda es motivada por su categoría', () => {
  assert.equal(clasificarModelo({ h: 16838, pages: 1 }, 'INSTANCIAS y ESCRITOS · DEMANDAS').foja_tipo, 'carta_motivada');
  assert.equal(clasificarModelo({ h: 16838, pages: 1 }, 'PODERES').foja_tipo, 'carta_simple');
});

test('sin el dato de páginas de Word se estima por palabras (450 por foja) y se marca', () => {
  assert.deepEqual(clasificarModelo({ h: 15840, pages: null, words: 900 }, 'PODERES'), { fojas: 2, foja_tipo: 'carta_simple', estimadas: true });
  assert.equal(clasificarModelo({ h: 15840, words: 10 }, 'PODERES').fojas, 1);
});

test('sin fojas o con un tipo desconocido no hay precio', () => {
  assert.equal(precioDeModelo({ fojas: null, foja_tipo: 'legal_simple' }), null);
  assert.equal(precioDeModelo({ fojas: 2, foja_tipo: 'otro' }), null);
  assert.equal(precioDeModelo(), null);
});

test('lee un Word real: tamaño, páginas y palabras', async () => {
  const r = await fojasDeModelo(path.join(__dirname, 'fixtures', 'venta-etiquetada.docx'), 'CONTRATOS CIVILES');
  assert.ok(['legal_simple', 'carta_simple'].includes(r.foja_tipo));
  assert.ok(Number.isInteger(r.fojas) && r.fojas >= 1);
});

// ---------- con base de datos: la lista trae el precio y sigue a las tarifas ----------
const { createAgentSchema } = require('./helpers/agentDb');

async function modelosSchema() {
  await createAgentSchema();
  await pool.query('DROP TABLE IF EXISTS doc_templates, doc_categories, pricing_rates CASCADE');
  await pool.query('CREATE TABLE doc_categories (id SERIAL PRIMARY KEY, name TEXT, parent_id INT)');
  await pool.query(`CREATE TABLE doc_templates (id SERIAL PRIMARY KEY, is_private BOOLEAN NOT NULL DEFAULT FALSE, created_by INT, publish_requested_at TIMESTAMPTZ,
    name TEXT, description TEXT, file_path TEXT, file_name TEXT, category_id INT, is_active BOOLEAN DEFAULT TRUE)`);
  await runSqlFile('migrations/20261124_tarifas_editables.sql');
  rates._reset();
  require('../src/documentos/templatesCatalog').clearCache?.();
}
test.after(async () => { await pool.end(); });

test('la lista de modelos trae el precio y cambia cuando Leo cambia la tarifa', async () => {
  await modelosSchema();
  const cat = (await pool.query(`INSERT INTO doc_categories (name) VALUES ('ACUERDOS') RETURNING id`)).rows[0].id;
  await pool.query(`INSERT INTO doc_templates (name, file_path, file_name, category_id, fojas, foja_tipo) VALUES
    ('Contrato', 'CONTRATOS CIVILES/x.docx', 'x.docx', $1, 2, 'legal_simple'), ('Sin calcular', 'CONTRATOS CIVILES/y.docx', 'y.docx', $1, NULL, NULL)`, [cat]);
  const { listModels } = require('../src/documentos/templatesCatalog');
  const byName = async () => Object.fromEntries((await listModels()).map((m) => [m.name, m]));
  let m = await byName();
  assert.equal(m.Contrato.precio, 500);
  assert.equal(m['Sin calcular'].precio, null);
  const cur = await rates.getRates({ fresh: true });
  await rates.saveRates({ ...cur, foja: { ...cur.foja, legal_simple: 275 } }, null);
  m = await byName();
  assert.equal(m.Contrato.precio, 550);
});

test('guardarFojas calcula fojas y tipo del Word; con soloSiFalta no pisa lo calculado', async () => {
  await modelosSchema();
  const cat = (await pool.query(`INSERT INTO doc_categories (name) VALUES ('NOTIFICACIONES') RETURNING id`)).rows[0].id;
  const id = (await pool.query(`INSERT INTO doc_templates (name, file_path, file_name, category_id) VALUES ('Acto', 'NOTIFICACIONES/a.docx', 'a.docx', $1) RETURNING id`, [cat])).rows[0].id;
  const { guardarFojas } = require('../src/documentos/templateTags');
  const file = path.join(__dirname, 'fixtures', 'venta-etiquetada.docx');
  const r = await guardarFojas(id, file);
  assert.match(r.foja_tipo, /_motivada$/);
  const row = (await pool.query('SELECT fojas, foja_tipo FROM doc_templates WHERE id = $1', [id])).rows[0];
  assert.deepEqual(row, { fojas: r.fojas, foja_tipo: r.foja_tipo });
  await pool.query('UPDATE doc_templates SET fojas = 7 WHERE id = $1', [id]);
  assert.equal(await guardarFojas(id, file, { soloSiFalta: true }), null);
  assert.equal((await pool.query('SELECT fojas FROM doc_templates WHERE id = $1', [id])).rows[0].fojas, 7);
});
