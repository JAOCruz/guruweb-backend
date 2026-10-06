const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { seedBotKnowledge } = require('../src/db/seedBotKnowledge');

const FIXTURES = path.join(__dirname, 'fixtures', 'seeds-bot');
const REAL = path.join(__dirname, '..', 'seeds', 'bot');
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

const VENTA_TIERS = [
  { min: 0, max: 100000, price: 500 }, { min: 100001, max: 800000, price: 700 },
  { min: 800001, max: 1000000, price: 1000 }, { min: 1000001, max: 3000000, price: 2000 },
  { min: 3000001, max: 5000000, price: 3000 }, { min: 5000001, max: null, price: 5000 },
];

test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS bot_tool_log, bot_memory, business_info, tramites, invoices, service_catalog, service_categories CASCADE`);
  await pool.query(`CREATE TABLE service_categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, category_id INT, digitacion_price NUMERIC, notarizacion_price NUMERIC, price_tiers JSONB, unit_type TEXT, active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY)`);
  await runSqlFile('migrations/20261005_bot_agent.sql');
  await pool.query(`INSERT INTO service_categories (id, name) VALUES (1, 'Redactar o digitar un documento'), (2, 'Mensajería')`);
  await pool.query(`INSERT INTO service_catalog (name, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type) VALUES
    ('Acto de Venta - Vehículo Liviano', 1, 250, 500, $1, 'por documento'),
    ('Acto de Venta - Motocicleta', 1, 200, 500, NULL, 'por documento'),
    ('Estatus Jurídico', 1, 1000, NULL, '[]', 'por inmueble')`, [JSON.stringify(VENTA_TIERS)]);
});
test.after(async () => { await pool.end(); });

const row = async (name) => (await pool.query(`SELECT * FROM service_catalog WHERE name = $1`, [name])).rows[0];
const count = async (name) => (await pool.query(`SELECT COUNT(*)::int n FROM service_catalog WHERE name = $1`, [name])).rows[0].n;

test('enriquece por nombre exacto y reporta los que no existen', async () => {
  const r = await seedBotKnowledge({ dir: FIXTURES });
  assert.equal(r.enriquecidos, 1);
  assert.ok(r.saltados.includes('Servicio Que No Existe'));
  const s = await row('Acto de Venta - Vehículo Liviano');
  assert.equal(s.descripcion, 'Contrato de venta de un carro.');
  assert.equal(s.incluye, 'Redacción y una impresión.');
  assert.deepEqual(s.alias, ['venta del carro', 'venta de carro']);
  assert.equal(s.notarizacion, 'opcional');
  assert.deepEqual(s.precio_rango, { min: 500, max: 900 });
  // Campos que no vienen no se tocan: el precio sigue igual.
  assert.equal(Number(s.digitacion_price), 250);
  assert.equal(s.reglas, null);
});

test('un servicio nuevo se inserta una vez; correrlo de nuevo no duplica ni cambia precios', async () => {
  const r1 = await seedBotKnowledge({ dir: FIXTURES });
  assert.equal(r1.nuevos, 2);
  assert.ok(r1.saltados.includes('Servicio Con Categoría Mala'));
  assert.equal(await count('Servicio Con Categoría Mala'), 0);
  const nuevo = await row('Servicio Nuevo');
  assert.equal(Number(nuevo.digitacion_price), 123);
  assert.equal(nuevo.unit_type, 'por servicio');
  assert.deepEqual(nuevo.alias, ['nuevo']);
  assert.equal(nuevo.reglas, 'Mínimo 24 h.');
  assert.equal(nuevo.active, true);
  assert.equal((await pool.query(`SELECT name FROM service_categories WHERE id = $1`, [nuevo.category_id])).rows[0].name, 'Mensajería');
  const sin = await row('Servicio Sin Precio');
  assert.equal(sin.por_confirmar, true);
  assert.equal(sin.digitacion_price, null);
  // Un servicio que ya existe nunca entra por "nuevos": su precio no cambia.
  assert.equal(Number((await row('Acto de Venta - Vehículo Liviano')).digitacion_price), 250);

  await pool.query(`UPDATE service_catalog SET digitacion_price = 999 WHERE name = 'Servicio Nuevo'`);
  const r2 = await seedBotKnowledge({ dir: FIXTURES });
  assert.equal(r2.nuevos, 0);
  assert.equal(await count('Servicio Nuevo'), 1);
  assert.equal(Number((await row('Servicio Nuevo')).digitacion_price), 999);
  assert.equal(await count('Acto de Venta - Vehículo Liviano'), 1);
});

test('conflictos marca por_confirmar y los tramos de actos de venta desde 3M', async () => {
  const r = await seedBotKnowledge({ dir: FIXTURES });
  assert.equal(r.conflictos, 2); // Estatus Jurídico + el acto de venta con tramos (el de tramos NULL no cuenta)
  assert.ok(r.saltados.includes('Conflicto Que No Existe'));
  const ej = await row('Estatus Jurídico');
  assert.equal(ej.por_confirmar, true);
  assert.match(ej.reglas, /RD\$1,000 en el sistema vs RD\$500/);
  const venta = await row('Acto de Venta - Vehículo Liviano');
  assert.equal(venta.por_confirmar, false); // solo los tramos, no el servicio entero
  for (const t of venta.price_tiers) {
    if (t.min >= 3000001) assert.equal(t.por_confirmar, true, `tramo ${t.min}`);
    else assert.equal(t.por_confirmar, undefined, `tramo ${t.min}`);
  }
  assert.equal(venta.price_tiers.length, 6);
  // Con price_tiers NULL no falla y queda NULL.
  assert.equal((await row('Acto de Venta - Motocicleta')).price_tiers, null);

  await seedBotKnowledge({ dir: FIXTURES });
  const again = await row('Estatus Jurídico');
  assert.equal(again.reglas.split('RD$1,000 en el sistema').length, 2, 'el motivo no se repite');
});

test('dry-run no deja cambios', async () => {
  const r = await seedBotKnowledge({ dir: FIXTURES, dryRun: true });
  assert.equal(r.enriquecidos, 1);
  assert.equal(r.nuevos, 2);
  assert.equal(r.conflictos, 2);
  assert.equal(r.tramites, 1);
  assert.equal(await count('Servicio Nuevo'), 0);
  assert.equal((await row('Acto de Venta - Vehículo Liviano')).alias.length, 0);
  assert.equal((await row('Estatus Jurídico')).por_confirmar, false);
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM tramites`)).rows[0].n, 0);
});

test('tramites hace upsert por nombre', async () => {
  await seedBotKnowledge({ dir: FIXTURES });
  await pool.query(`UPDATE tramites SET reglas = 'viejo' WHERE nombre = 'Traspaso de vehículo'`);
  const r = await seedBotKnowledge({ dir: FIXTURES });
  assert.equal(r.tramites, 1);
  const t = (await pool.query(`SELECT * FROM tramites`)).rows;
  assert.equal(t.length, 1);
  assert.equal(t[0].reglas, 'Mínimo 24 h.');
  assert.deepEqual(t[0].alias, ['traspaso', 'traspaso de carro']);
  assert.deepEqual(t[0].preguntas_obligatorias, ['¿Cuál es el valor del vehículo?']);
  assert.equal(t[0].pasos.length, 3);
  assert.equal(t[0].pasos[2].servicio, null);
});

test('los JSON reales de seeds/bot son válidos: 7 trámites con los nombres del plan, y cada paso.servicio es null o un nombre que está en servicios-nuevos o en el snapshot del catálogo', () => {
  const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, 'agent', 'catalog-snapshot.json'), 'utf8'));
  const catalogNames = new Set(snapshot.service_catalog.map((s) => s.name));
  const categoryNames = new Set(snapshot.service_categories.map((c) => c.name));
  const enriquecidos = readJson(REAL, 'servicios-enriquecidos.json');
  const nuevos = readJson(REAL, 'servicios-nuevos.json');
  const conflictos = readJson(REAL, 'conflictos.json');
  const tramites = readJson(REAL, 'tramites.json');

  const nuevosNames = new Set();
  for (const n of nuevos) {
    assert.ok(n.nombre && n.categoria, `nuevo sin nombre/categoría: ${JSON.stringify(n)}`);
    assert.ok(categoryNames.has(n.categoria), `categoría desconocida "${n.categoria}" en "${n.nombre}"`);
    assert.ok(!catalogNames.has(n.nombre), `"${n.nombre}" ya está en el catálogo: no va en nuevos`);
    assert.ok(!nuevosNames.has(n.nombre), `nuevo duplicado: ${n.nombre}`);
    nuevosNames.add(n.nombre);
    const hasPrice = n.digitacion_price != null || n.notarizacion_price != null || n.precio_rango;
    assert.ok(hasPrice || n.por_confirmar === true, `"${n.nombre}" sin precio debe ir por_confirmar`);
  }
  const enrNames = new Set();
  for (const e of enriquecidos) {
    assert.ok(catalogNames.has(e.nombre), `enriquecido no está en el catálogo: "${e.nombre}"`);
    assert.ok(!enrNames.has(e.nombre), `enriquecido duplicado: ${e.nombre}`);
    enrNames.add(e.nombre);
    if (e.notarizacion) assert.ok(['opcional', 'obligatoria', 'no_aplica'].includes(e.notarizacion), e.nombre);
  }
  for (const c of conflictos) {
    if (c.grupo) assert.ok(Number.isInteger(c.tramos_desde), 'grupo sin tramos_desde');
    else assert.ok(catalogNames.has(c.nombre) && c.motivo, `conflicto inválido: ${JSON.stringify(c)}`);
  }
  assert.ok(conflictos.some((c) => c.grupo === 'Acto de Venta' && c.tramos_desde === 3000001));

  const esperados = ['Traspaso de vehículo', 'Salida de menor', 'Ayuntamiento', 'Compulsa', 'Apostilla de documento', 'Apostilla de certificación', 'Legalización de traducción'];
  assert.deepEqual(tramites.map((t) => t.nombre).sort(), [...esperados].sort());
  for (const t of tramites) {
    assert.ok(Array.isArray(t.alias) && t.alias.length > 0, `${t.nombre} sin alias`);
    assert.ok(Array.isArray(t.pasos) && t.pasos.length > 0, `${t.nombre} sin pasos`);
    assert.ok(Array.isArray(t.preguntas_obligatorias) && t.preguntas_obligatorias.length > 0, `${t.nombre} sin preguntas`);
    assert.equal(typeof t.reglas, 'string');
    t.pasos.forEach((p, i) => {
      assert.equal(p.orden, i + 1, `${t.nombre}: orden del paso ${i + 1}`);
      assert.ok(p.descripcion, `${t.nombre}: paso sin descripción`);
      assert.ok(p.servicio === null || catalogNames.has(p.servicio) || nuevosNames.has(p.servicio),
        `${t.nombre}: paso.servicio "${p.servicio}" no existe`);
    });
  }
  const salida = tramites.find((t) => t.nombre === 'Salida de menor');
  assert.match(salida.reglas, /24 h/);
});
