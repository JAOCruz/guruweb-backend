// Precios de las capturas de Leandro: si el catálogo difiere, manda la captura (Jay, 2026-10-28).
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema } = require('./helpers/agentDb');
const { calculatePrice } = require('../src/models/servicePricing');
const snap = require('./agent/catalog-snapshot.json');
const test = require('node:test');
const assert = require('node:assert/strict');

const MIG = 'migrations/20261028_precios_capturas.sql';
const NAMES = ['Acto de Venta - Vehículo Liviano', 'Acto de Venta - Bien Inmueble', 'Contrato de Venta Bienes',
  'Poder Especial de Autorización (Sencillo)', 'Poder Especial de Autorización (Extensivo)',
  'Declaración Jurada - Mejora Const. Particulares', 'Declaración Jurada - Soltería',
  'Traducción - Varias Páginas, Solo Texto (Documento Extranjero)'];

test.before(async () => {
  await createAgentSchema();
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS fojas INT, ADD COLUMN IF NOT EXISTS foja_tipo TEXT`);
  await pool.query(`INSERT INTO service_categories (name) VALUES ('Redactar o digitar un documento')`);
  for (const s of snap.service_catalog.filter((x) => NAMES.includes(x.name))) {
    await pool.query(`INSERT INTO service_catalog (name, category_id, digitacion_price, notarizacion_price, price_tiers, fojas, foja_tipo, unit_type)
      VALUES ($1, 1, $2, $3, $4, $5, $6, 'por documento')`,
      [s.name, s.digitacion_price, s.notarizacion_price, JSON.stringify(s.price_tiers || []), s.fojas, s.foja_tipo]);
  }
  await runSqlFile(MIG);
  await runSqlFile(MIG); // idempotente
});
test.after(() => pool.end());

const svc = async (name) => (await pool.query('SELECT * FROM service_catalog WHERE name = $1', [name])).rows;
const total = async (name, opts = {}) => calculatePrice((await svc(name))[0], opts).total;

test('captura 03: acto de venta de vehículo sencillo = redacción 500 + notarización del tramo', async () => {
  assert.equal(await total('Acto de Venta - Vehículo Liviano', { assetValue: 100000 }), 1000);
  assert.equal(await total('Acto de Venta - Vehículo Liviano', { assetValue: 700000 }), 1500);
  assert.equal(await total('Acto de Venta - Vehículo Liviano', { assetValue: 2000000 }), 2500);
});

test('captura 14: tarifas de notarización de contratos traslativos', async () => {
  const s = (await svc('Contrato de Venta Bienes'))[0];
  const not = (v) => calculatePrice(s, { assetValue: v }).total - 250; // redacción de 1 foja
  assert.deepEqual([100000, 400000, 900000, 2000000, 4000000, 6000000].map(not), [500, 700, 1000, 2000, 4000, 8000]);
  assert.equal(calculatePrice(s, { assetValue: 9000000 }).total, null, 'más de 8 millones: por confirmar');
  assert.equal((await svc('Acto de Venta - Bien Inmueble'))[0].price_tiers.length, 6);
});

test('captura 15: poder sencillo 1,000, extensivo 1,500 y avanzado desde 2,000; la notarización sola 700 (captura 05)', async () => {
  assert.equal(await total('Poder Especial de Autorización (Sencillo)'), 1000);
  assert.equal(calculatePrice((await svc('Poder Especial de Autorización (Sencillo)'))[0], { includeNotarization: false }).total, 300);
  assert.equal(await total('Poder Especial de Autorización (Extensivo)'), 1500);
  const [av] = await svc('Poder Especial de Autorización (Avanzado)');
  assert.equal(calculatePrice(av).total, 2000);
  assert.match(av.reglas, /desde/);
});

test('captura 07: declaración jurada de mejora 500 / 1,500; las demás no cambian', async () => {
  const d = (await svc('Declaración Jurada - Mejora Const. Particulares'))[0];
  assert.equal(calculatePrice(d).total, 1500);
  assert.equal(calculatePrice(d, { includeNotarization: false }).total, 500);
  assert.equal(await total('Declaración Jurada - Soltería'), 950);
});

test('capturas 04 y 08: traducción extranjera 800 por página y la factura 250', async () => {
  assert.equal(await total('Traducción - Varias Páginas, Solo Texto (Documento Extranjero)'), 800);
  const [f] = await svc('Factura (digitación)');
  assert.equal(calculatePrice(f).total, 250);
  assert.doesNotMatch(f.reglas, /RD\$|\d{3}/);
  assert.equal((await svc('Factura (digitación)')).length, 1);
});

test('captura 14: notarizar un contrato ya redactado va por el valor del bien; los ejemplares extra son duplicados', async () => {
  await pool.query(`INSERT INTO service_categories (name) VALUES ('Notarización')`);
  await pool.query(`ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS incluye TEXT`);
  await runSqlFile('migrations/20261028_notarizacion_contratos.sql');
  await runSqlFile('migrations/20261028_notarizacion_contratos.sql');
  const rows = await svc('Notarización de Contrato (solo notarizar)');
  assert.equal(rows.length, 1);
  const [s] = rows;
  assert.deepEqual([100000, 400000, 900000, 4000000].map((v) => calculatePrice(s, { assetValue: v }).total), [500, 700, 1000, 4000]);
  assert.equal(calculatePrice(s, {}).falta, 'valor_del_bien');
  assert.ok(calculatePrice(s, { assetValue: 400000, duplicados: 2 }).total > 700);
  assert.doesNotMatch(s.reglas + s.incluye, /RD\$|\d{3}/);
});
