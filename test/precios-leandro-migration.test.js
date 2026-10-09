const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

const NOTA = (m) => `Precio por confirmar: ${m}`;
const TABLA_VIEJA_VENTA = [
  { min: 0, max: 100000, price: 500 }, { min: 100001, max: 800000, price: 700 },
  { min: 800001, max: 1000000, price: 1000 }, { min: 1000001, max: 3000000, price: 2000 },
  { min: 3000001, max: 5000000, price: 3000, por_confirmar: true }, { min: 5000001, max: null, price: 5000, por_confirmar: true },
];
const TABLA_B = [
  { min: 0, max: 150000, price: 500 }, { min: 150001, max: 500000, price: 700 },
  { min: 600000, max: 1000000, price: 1000 }, { min: 1000001, max: 3000000, price: 2000 },
  { min: 3000001, max: 5000000, price: 4000, por_confirmar: true }, { min: 5000001, max: 8000000, price: 5000, por_confirmar: true },
  { min: 8000001, max: 10000000, price: 10000, por_confirmar: true },
];
const TABLA_A = [
  { min: 0, max: 100000, price: 500, label: 'Hasta RD$100K' }, { min: 100001, max: 800000, price: 700, label: 'RD$100K-800K' },
  { min: 800001, max: 1000000, price: 1000, label: 'RD$800K-1M' }, { min: 1000001, max: 3000000, price: 2000, label: 'RD$1M-3M' },
  { min: 3000001, max: 5000000, price: 3000, label: 'RD$3M-5M' }, { min: 5000001, max: null, price: 5000, label: 'RD$5M+' },
];
const MENSAJERIA = ['Legalización en Procuraduría', 'Depósito de Traspaso en DGII', 'Depósito de Documentos en Migración',
  'Registro en Ayuntamiento', 'Recolección de Firmas', 'Solicitud de Certificación'].map((n) => `Mensajería - ${n}`);

test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS bot_tool_log, bot_memory, business_info, tramites, invoices, tasas_cache, service_catalog, service_categories CASCADE`);
  await pool.query(`CREATE TABLE service_categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, category_id INT, digitacion_price NUMERIC, notarizacion_price NUMERIC, price_tiers JSONB, unit_type TEXT, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY)`);
  await runSqlFile('migrations/20261005_bot_agent.sql');
  await pool.query(`INSERT INTO service_categories (id, name) VALUES (1, 'Redactar o digitar un documento'), (2, 'Mensajería'), (3, 'Fotos 2x2'), (4, 'Impresión')`);
  const ins = (name, cat, dig, notar, tiers, unit, pc, reglas) => pool.query(
    `INSERT INTO service_catalog (name, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type, por_confirmar, reglas)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [name, cat, dig, notar, tiers ? JSON.stringify(tiers) : null, unit, pc, reglas]);
  await ins('Certificación Estatus Jurídico Inmueble', 1, 1000, null, null, 'por inmueble', true, NOTA('no coincide.'));
  await ins('Instancia - Recurso de Amparo', 1, 500, null, null, 'por documento', true, NOTA('varía.'));
  await ins('Instancia Sencilla', 1, 150, null, null, 'por hoja', true, null);
  await ins('Estatutos Sociales', 1, 250, 1500, null, 'por documento', true, NOTA('no coincide.'));
  await ins('Nómina de Pagos/Presencia', 1, 300, 500, null, 'por documento', true, NOTA('no coincide.'));
  await ins('Foto 2x2', 3, 300, null, null, 'por unidad', true, NOTA('por unidad.'));
  await ins('Fotocopia 11x17"', 4, 20, null, null, 'por unidad', true, NOTA('no coincide.'));
  await ins('Escáner de Documento', 4, 5, null, null, 'por hoja', true, NOTA('escala.'));
  await ins('Acto de Venta - Vehículo Liviano', 1, 250, 500, TABLA_VIEJA_VENTA, 'por documento', false, null);
  await ins('Contrato de Venta Bienes', 1, 300, null, TABLA_B, 'por documento', false, null);
  await ins('Mensajería Local (Santo Domingo)', 2, 200, null, null, 'por servicio', false, null);
  for (const n of MENSAJERIA) await ins(n, 2, null, null, null, 'por servicio', true, 'Precio por confirmar con el digitador (la documentación no fija una tarifa). Requiere 24 horas.');
});
test.after(async () => { await pool.end(); });

const row = async (name) => (await pool.query(`SELECT * FROM service_catalog WHERE name = $1`, [name])).rows[0];
const count = async (name) => (await pool.query(`SELECT COUNT(*)::int n FROM service_catalog WHERE name = $1`, [name])).rows[0].n;
const occurrences = (s, sub) => s.split(sub).length - 1;
const migrar = async () => { await runSqlFile('migrations/20261009_precios_leandro_1.sql'); await runSqlFile('migrations/20261009_precios_leandro_1.sql'); };

test('las correcciones de Leandro quedan aplicadas y la migración es idempotente', async () => {
  await migrar();
  const ej = await row('Certificación Estatus Jurídico Inmueble');
  assert.equal(ej.por_confirmar, false);
  assert.equal(occurrences(ej.reglas, 'No incluye impuestos'), 1);
  assert.doesNotMatch(ej.reglas, /Precio por confirmar/);
  const otros = (await pool.query(`SELECT name, por_confirmar FROM service_catalog WHERE name LIKE 'Instancia%' OR name IN ('Estatutos Sociales','Nómina de Pagos/Presencia')`)).rows;
  assert.equal(otros.length, 4);
  for (const o of otros) assert.equal(o.por_confirmar, false, o.name);
  const foto = await row('Foto 2x2');
  assert.equal(Number(foto.digitacion_price), 250);
  assert.equal(foto.unit_type, 'por juego de hasta 5 fotos');
  assert.equal(foto.por_confirmar, false);
  const copia = await row('Fotocopia 11x17"');
  assert.equal(Number(copia.digitacion_price), 50);
  assert.equal(copia.por_confirmar, false);
  assert.equal(occurrences(copia.reglas, 'RD$100'), 1);
  const esc = await row('Escáner de Documento');
  assert.equal(esc.por_confirmar, true);
  assert.equal(Number(esc.digitacion_price), 5);
});

test('actos de venta y contrato de venta usan la tabla A sin tramos por confirmar', async () => {
  await migrar();
  const acto = await row('Acto de Venta - Vehículo Liviano');
  assert.equal(acto.price_tiers.length, 6);
  for (const t of acto.price_tiers) assert.equal('por_confirmar' in t, false, `tramo ${t.min}`);
  assert.deepEqual((await row('Contrato de Venta Bienes')).price_tiers, TABLA_A);
});

test('mensajería: 1000 sin impuestos, envío por Uber por confirmar y servicios nuevos una sola vez', async () => {
  await migrar();
  for (const n of ['Legalización en Procuraduría', 'Depósito de Traspaso en DGII', 'Solicitud de Certificación']) {
    const r = await row(`Mensajería - ${n}`);
    assert.equal(Number(r.digitacion_price), 1000, n);
    assert.equal(r.unit_type, 'por documento');
    assert.equal(r.por_confirmar, false);
    assert.equal(occurrences(r.reglas, 'No incluye impuestos'), 1);
  }
  for (const n of ['Depósito de Documentos en Migración', 'Registro en Ayuntamiento', 'Recolección de Firmas']) {
    const r = await row(`Mensajería - ${n}`);
    assert.equal(r.por_confirmar, true, n);
    assert.equal(occurrences(r.reglas, 'pendiente de Leandro'), 1);
  }
  assert.equal(await count('Mensajería Local (Santo Domingo)'), 0);
  const uber = await row('Envío al cliente (Uber)');
  assert.equal(uber.digitacion_price, null);
  assert.equal(uber.por_confirmar, true);
  assert.equal(uber.notarizacion, 'no_aplica');
  assert.match(uber.reglas, /Uber/);
  assert.equal(uber.alias.filter((a) => a === 'mensajería local').length, 1);
  for (const n of ['Depósito en Cámara de Comercio', 'Cancillería (MIREX)', 'Ministerio de Educación', 'MESCYT']) {
    assert.equal(await count(`Mensajería - ${n}`), 1, n);
    const r = await row(`Mensajería - ${n}`);
    assert.equal(Number(r.digitacion_price), 1000);
    assert.equal(r.por_confirmar, false);
  }
});

test('duplicados: dos servicios nuevos, una sola vez', async () => {
  await migrar();
  const cat = (await pool.query(`SELECT id FROM service_categories WHERE name = 'Redactar o digitar un documento'`)).rows[0].id;
  for (const [n, p] of [['Original adicional o duplicado (1 o 2 fojas)', 500], ['Original adicional o duplicado (3 o más fojas)', 700]]) {
    assert.equal(await count(n), 1, n);
    const r = await row(n);
    assert.equal(Number(r.digitacion_price), p);
    assert.equal(r.unit_type, 'por original');
    assert.equal(r.category_id, cat);
  }
});

test('columnas de fojas y caché de tasas', async () => {
  await migrar();
  await pool.query(`UPDATE service_catalog SET foja_tipo = 'legal_simple', fojas = 2 WHERE name = 'Estatutos Sociales'`);
  const e = await row('Estatutos Sociales');
  assert.equal(e.foja_tipo, 'legal_simple');
  assert.equal(e.fojas, 2);
  await assert.rejects(pool.query(`UPDATE service_catalog SET foja_tipo = 'otro' WHERE name = 'Estatutos Sociales'`), /check/i);
  await pool.query(`INSERT INTO tasas_cache (concepto_key, concepto, monto) VALUES ('marbete', 'Marbete', 1000)`);
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM tasas_cache`)).rows[0].n, 1);
});
