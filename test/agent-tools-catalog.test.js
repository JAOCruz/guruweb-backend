const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buscar_servicio, calcular_precio } = require('../src/agent/tools/catalog');
const { ver_tramite } = require('../src/agent/tools/tramites');

let ids = {};
test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS bot_tool_log, bot_memory, business_info, tramites, invoices, service_catalog, service_categories CASCADE`);
  await pool.query(`CREATE TABLE service_categories (id SERIAL PRIMARY KEY, name TEXT)`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, category_id INT, digitacion_price NUMERIC, notarizacion_price NUMERIC, price_tiers JSONB DEFAULT '[]', unit_type TEXT, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY)`);
  await runSqlFile('migrations/20261005_bot_agent.sql');
  await runSqlFile('migrations/20261009_precios_leandro_1.sql');
  await pool.query(`INSERT INTO service_categories (id, name) VALUES (1, 'Actos de venta')`);
  const ins = async (name, cols = {}) => {
    const c = { name, category_id: 1, unit_type: 'por documento', ...cols };
    const keys = Object.keys(c);
    const r = await pool.query(
      `INSERT INTO service_catalog (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      keys.map((k) => (k === 'price_tiers' || k === 'precio_rango' ? JSON.stringify(c[k]) : c[k])));
    return r.rows[0].id;
  };
  ids.venta = await ins('Acto de Venta - Vehículo Liviano', {
    digitacion_price: 500, notarizacion_price: 300, alias: ['venta del carro', 'venta de carro'],
    price_tiers: [{ min: 0, max: 1000000, price: 450 }, { min: 1000001, max: null, price: 900, por_confirmar: true }],
    incluye: 'Redacción', notarizacion: 'opcional', tiempo_entrega: '1 día',
  });
  ids.conf = await ins('Estatus Jurídico', { digitacion_price: 1000, por_confirmar: true });
  ids.a = await ins('Copia certificada', { digitacion_price: 700, notarizacion_price: 0 });
  ids.b = await ins('Legalización', { digitacion_price: 1000 });
  ids.foja = await ins('Carta Legal Simple', { digitacion_price: 100, foja_tipo: 'legal_simple', fojas: 2 });
  ids.inactivo = await ins('Venta de carro vieja', { digitacion_price: 1, active: false, alias: ['venta del carro'] });
  const pasos = (arr) => JSON.stringify(arr);
  await pool.query(`INSERT INTO tramites (nombre, alias, pasos, preguntas_obligatorias, reglas) VALUES
    ('Traspaso de vehículo', ARRAY['traspaso de carro'], $1, ARRAY['¿Tiene la matrícula?'], 'Con cédula'),
    ('Trámite incompleto', ARRAY[]::text[], $2, ARRAY[]::text[], NULL),
    ('Trámite informativo', ARRAY[]::text[], $3, ARRAY[]::text[], NULL)`, [
    pasos([{ orden: 1, descripcion: 'Copia', servicio: 'Copia certificada', preguntas: [] }, { orden: 2, descripcion: 'Legalizar', servicio: 'Legalización', preguntas: ['¿Cuántas?'] }]),
    pasos([{ orden: 1, descripcion: 'Copia', servicio: 'Copia certificada' }, { orden: 2, descripcion: 'Estatus', servicio: 'Estatus Jurídico' }, { orden: 3, descripcion: 'Otro', servicio: 'No existe' }]),
    pasos([{ orden: 1, descripcion: 'Copia', servicio: 'Copia certificada' }, { orden: 2, descripcion: 'Ir a la DGII', servicio: null }]),
  ]);
});
test.after(async () => { await pool.end(); });

test('"venta del carro" encuentra el acto de venta de vehículo por su alias', async () => {
  const r = await buscar_servicio({ consulta: 'venta del carro' });
  assert.equal(r.resultados[0].nombre, 'Acto de Venta - Vehículo Liviano');
  assert.equal(r.resultados[0].categoria, 'Actos de venta');
  assert.equal(r.resultados[0].unidad, 'por documento');
  assert.ok(!r.resultados.some((x) => x.nombre === 'Venta de carro vieja'));
});
test('busca sin importar acentos: "vehiculo" encuentra "Vehículo"', async () => {
  const r = await buscar_servicio({ consulta: 'VEHICULO liviano' });
  assert.equal(r.resultados[0].nombre, 'Acto de Venta - Vehículo Liviano');
  // Por tramos: sin valor del bien no hay precio (lo da calcular_precio con valor_del_bien).
  assert.equal(r.resultados[0].precio, null);
  assert.equal(r.resultados[0].depende_del_valor, true);
});
test('sin coincidencias devuelve lista vacía', async () => {
  assert.deepEqual(await buscar_servicio({ consulta: 'zzzz' }), { resultados: [] });
});
test('un servicio por confirmar sale con precio null y por_confirmar true', async () => {
  const r = await buscar_servicio({ consulta: 'estatus juridico' });
  assert.equal(r.resultados[0].precio, null);
  assert.equal(r.resultados[0].por_confirmar, true);
});
test('calcular_precio con valor 500000 da 950 y el tramo', async () => {
  const r = await calcular_precio({ servicio_id: ids.venta, valor_del_bien: 500000 });
  assert.equal(r.total, 950);
  assert.equal(r.tramo, '0-1000000');
  assert.equal(r.servicio, 'Acto de Venta - Vehículo Liviano');
  assert.equal(r.desglose.digitacion, 500);
  const sin = await calcular_precio({ servicio_id: ids.venta, valor_del_bien: 500000, con_notarizacion: false });
  assert.equal(sin.total, 500);
});
test('calcular_precio con un id que no existe devuelve error, no lanza', async () => {
  assert.deepEqual(await calcular_precio({ servicio_id: 99999 }), { error: 'servicio no encontrado' });
});
test('ver_tramite suma los pasos con precio', async () => {
  const r = await ver_tramite({ nombre: 'traspaso de carro' });
  assert.equal(r.total, 1700);
  assert.deepEqual(r.faltan_precios, []);
  assert.equal(r.pasos[0].precio, 700);
  assert.deepEqual(r.preguntas_obligatorias, ['¿Tiene la matrícula?']);
});
test('ver_tramite con un paso sin precio: total null y lo lista en faltan_precios', async () => {
  const r = await ver_tramite({ nombre: 'tramite incompleto' });
  assert.equal(r.total, null);
  assert.deepEqual(r.faltan_precios, ['Estatus Jurídico', 'No existe']);
});
test('ver_tramite: un paso informativo (servicio null) no vuelve el total null', async () => {
  const r = await ver_tramite({ nombre: 'Trámite informativo' });
  assert.equal(r.total, 700);
  assert.deepEqual(r.faltan_precios, []);
  assert.equal(r.pasos[1].precio, null);
});
test('ver_tramite desconocido devuelve los disponibles', async () => {
  const r = await ver_tramite({ nombre: 'nada' });
  assert.equal(r.error, 'trámite no encontrado');
  assert.ok(r.disponibles.includes('Traspaso de vehículo'));
});

async function addVentas() {
  for (const [n, al] of [['Acto de Venta - Moto', ['motor']], ['Acto de Venta - Inmueble', ['casa']], ['Acto de Venta - Camión', ['camion']], ['Acto de Venta - Vehículo Pesado', ['vehiculo pesado', 'carro']]]) {
    await pool.query(`INSERT INTO service_catalog (name, category_id, digitacion_price, alias) VALUES ($1,1,100,$2)`, [n, al]);
  }
}
test('consulta natural sin alias exacto: gana el que tiene "carro"; "del"/"venta" solos no deciden', async () => {
  await addVentas();
  await pool.query(`UPDATE service_catalog SET alias='{}' WHERE id=$1`, [ids.venta]);
  await pool.query(`UPDATE service_catalog SET alias=ARRAY['carro'] WHERE id=$1`, [ids.venta]);
  const r = await buscar_servicio({ consulta: 'quiero la venta del carro' });
  assert.equal(r.resultados[0].nombre, 'Acto de Venta - Vehículo Liviano');
  const plural = await buscar_servicio({ consulta: 'ventas de carros' });
  assert.ok(['Acto de Venta - Vehículo Liviano', 'Acto de Venta - Vehículo Pesado'].includes(plural.resultados[0].nombre));
  const solo = await buscar_servicio({ consulta: 'del' });
  assert.deepEqual(solo, { resultados: [] });
});
test('una consulta solo de stopwords devuelve lista vacía', async () => {
  assert.deepEqual(await buscar_servicio({ consulta: 'quiero la del por' }), { resultados: [] });
});
test('empates: el mismo orden en cada llamada (por nombre y luego id)', async () => {
  await addVentas();
  const a = await buscar_servicio({ consulta: 'acto de venta' });
  const b = await buscar_servicio({ consulta: 'acto de venta' });
  assert.deepEqual(a.resultados.map((x) => x.id), b.resultados.map((x) => x.id));
  const tied = a.resultados.map((x) => x.id);
  assert.deepEqual(tied, [...tied].sort((x, y) => x - y));
});

// ---------- tramos: sin valor del bien no hay precio ----------

test('buscar_servicio: un servicio por tramos sale sin precio y con depende_del_valor', async () => {
  const r = await buscar_servicio({ consulta: 'venta del carro' });
  assert.equal(r.resultados[0].id, ids.venta);
  assert.equal(r.resultados[0].precio, null);
  assert.equal(r.resultados[0].depende_del_valor, true);
  assert.equal(r.resultados[0].por_confirmar, false);
  const c = await buscar_servicio({ consulta: 'legalizacion' });
  assert.equal(c.resultados[0].precio, 1000);
  assert.equal(c.resultados[0].depende_del_valor, false);
});
test('calcular_precio por tramos sin valor del bien: total null y falta valor_del_bien', async () => {
  const r = await calcular_precio({ servicio_id: ids.venta });
  assert.equal(r.total, null); assert.equal(r.falta, 'valor_del_bien'); assert.equal(r.por_confirmar, false);
  const con = await calcular_precio({ servicio_id: ids.venta, valor_del_bien: 500000 });
  assert.equal(con.total, 950); assert.equal(con.falta, null);
});
test('ver_tramite: un paso por tramos (sin valor) queda en faltan_precios y el total es null', async () => {
  await pool.query(`INSERT INTO tramites (nombre, alias, pasos, preguntas_obligatorias, reglas) VALUES ('Venta con acto', ARRAY[]::text[], $1, ARRAY[]::text[], NULL)`,
    [JSON.stringify([{ orden: 1, descripcion: 'Acto', servicio: 'Acto de Venta - Vehículo Liviano' }, { orden: 2, descripcion: 'Copia', servicio: 'Copia certificada' }])]);
  const r = await ver_tramite({ nombre: 'Venta con acto' });
  assert.equal(r.total, null);
  assert.deepEqual(r.faltan_precios, ['Acto de Venta - Vehículo Liviano']);
  assert.equal(r.pasos[0].precio, null);
  assert.equal(r.pasos[0].depende_del_valor, true);
  assert.equal(r.pasos[1].precio, 700);
});

test('buscar_servicio: por_foja trae tarifa_por_foja (monto permitido) y las fojas aproximadas, no como monto', async () => {
  const { collectAmounts } = require('../src/agent/agent');
  const { resultados } = await buscar_servicio({ consulta: 'carta legal simple' });
  const f = resultados.find((x) => x.id === ids.foja);
  assert.deepEqual(f.por_foja, { tipo: 'legal_simple', tarifa_por_foja: 250, fojas_aprox: 2 });
  const s = collectAmounts({ resultados }, new Set());
  assert.ok(s.has(250)); assert.ok(!s.has(2));
});
test('servicio por foja: calcular_precio usa la tarifa y marca las fojas como estimadas', async () => {
  const r = await calcular_precio({ servicio_id: ids.foja });
  assert.equal(r.total, 500);
  assert.equal(r.tarifa_por_foja, 250);
  assert.equal(r.fojas, 2);
  assert.equal(r.fojas_estimadas, true);
  assert.ok(!('tarifa_por_foja' in r.desglose) && !('fojas' in r.desglose));
});
test('con fojas dadas, calcular_precio ya no es estimado; duplicados salen en el desglose', async () => {
  const r = await calcular_precio({ servicio_id: ids.foja, fojas: 4 });
  assert.equal(r.total, 1000);
  assert.equal(r.fojas, 4);
  assert.equal(r.fojas_estimadas, false);
  const d = await calcular_precio({ servicio_id: ids.foja, fojas: 2, duplicados: 1 });
  assert.equal(d.desglose.duplicados, 500);
  assert.equal(d.total, 1000);
});
test('buscar_servicio trae por_foja (o null si no va por foja)', async () => {
  const r = await buscar_servicio({ consulta: 'carta legal simple' });
  assert.deepEqual(r.resultados[0].por_foja, { tipo: 'legal_simple', tarifa_por_foja: 250, fojas_aprox: 2 });
  const o = await buscar_servicio({ consulta: 'copia certificada' });
  assert.equal(o.resultados[0].por_foja, null);
});

test('calcular_precio: cantidad son documentos aparte; las fojas de un servicio por foja van en fojas', () => {
  const { TOOLS } = require('../src/agent/tools');
  const p = TOOLS.find((t) => t.name === 'calcular_precio').parameters.properties;
  assert.doesNotMatch(p.cantidad.description, /documentos, páginas/);
  assert.match(p.cantidad.description, /documentos/);
  assert.match(p.cantidad.description, /fojas/);
  assert.match(p.cantidad.description, /no en cantidad|no van en cantidad|nunca en cantidad/i);
});

test('calcular_precio y buscar_servicio devuelven precio_sugerido de un servicio por confirmar', async () => {
  const r = await calcular_precio({ servicio_id: ids.conf, cantidad: 2 });
  assert.equal(r.total, null);
  assert.equal(r.por_confirmar, true);
  assert.equal(r.precio_sugerido, 2000);
  assert.equal((await calcular_precio({ servicio_id: ids.b })).precio_sugerido, null);
  const b = await buscar_servicio({ consulta: 'estatus juridico' });
  const hit = (b.resultados || b.servicios || b).find?.((x) => x.id === ids.conf);
  assert.equal(hit.precio_sugerido, 1000);
});
