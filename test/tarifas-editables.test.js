// Tarifas editables: por foja y de traducción (precio por página con rebaja por cantidad), guardadas en pricing_rates.
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const cookieParser = require('cookie-parser');
const { pool, runSqlFile } = require('./helpers/db');
const { createAgentSchema, createUser } = require('./helpers/agentDb');
const { generateToken } = require('../src/middleware/auth');
const rates = require('../src/models/pricingRates');
const { FOJA_RATES } = require('../src/models/fojaRates');
const { calculatePrice } = require('../src/models/servicePricing');

const MIGRATION = 'migrations/20261124_tarifas_editables.sql';
let server, base, tok;

test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/service-catalog', require('../src/routes/serviceCatalog'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await createAgentSchema();
  await pool.query('DROP TABLE IF EXISTS pricing_rates, activity_log CASCADE');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20261009_precios_leandro_1.sql');
  await pool.query(`INSERT INTO service_categories (name) VALUES ('Redactar y Certificar una Traducción')`);
  await pool.query(`INSERT INTO service_catalog (name, digitacion_price, unit_type, active) VALUES
    ('Traducción - Acta Natal (Idiomas básicos)', 700, 'por documento', true),
    ('Traducción - Una Página (Documento Nativo)', 600, 'por hoja', true)`);
  await runSqlFile(MIGRATION);
  rates._reset();
  const adminId = await createUser('leandro', 'admin', 'Leandro');
  const digId = await createUser('hengi', 'digitador', 'Hengi');
  tok = {
    admin: generateToken({ id: adminId, username: 'leandro', email: 'l@t.co', role: 'admin' }),
    hengi: generateToken({ id: digId, username: 'hengi', email: 'h@t.co', role: 'digitador' }),
  };
});
test.after(async () => { server.close(); await pool.end(); });

const req = (method, who, body) => fetch(`${base}/api/service-catalog/rates`, {
  method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok[who]}` }, body: body && JSON.stringify(body) });
const svc = async (name) => (await pool.query('SELECT * FROM service_catalog WHERE name = $1', [name])).rows[0];

test('la migración se puede correr dos veces y siembra las tarifas de siempre', async () => {
  await runSqlFile(MIGRATION);
  const r = await rates.getRates({ fresh: true });
  assert.deepEqual(r.foja, { carta_simple: 150, carta_motivada: 300, legal_simple: 250, legal_motivada: 350, modificacion: 150 });
  assert.deepEqual(r.traduccion.tipos.map((t) => t.key), ['carta_sencillo', 'carta_denso', 'legal_denso']);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM service_catalog WHERE traduccion_tipo IS NOT NULL`)).rows[0].n, 3);
});

test('los servicios de traducción viejos quedan inactivos, no se borran', async () => {
  const viejo = await svc('Traducción - Acta Natal (Idiomas básicos)');
  assert.equal(viejo.active, false);
  assert.equal((await svc('Traducción - Carta sencillo')).active, true);
});

test('traducción: el precio por página baja por tramos y el total es tramo × páginas', async () => {
  await rates.refreshRates();
  const t = (p) => rates.traduccionPrecio('carta_denso', p);
  assert.deepEqual([1, 2, 3, 9, 10, 15].map((p) => t(p).total), [1000, 2000, 2400, 7200, 7000, 10500]);
  assert.equal(t(3).porPagina, 800);
  assert.equal(t(10).porPagina, 700);
  assert.equal(rates.traduccionPrecio('no_existe', 2), null);
});

test('calculatePrice de una traducción usa las páginas (en fojas) y avisa si son estimadas', async () => {
  await rates.refreshRates();
  const s = await svc('Traducción - Legal extensivo o denso');
  const r = calculatePrice(s, { fojas: 4 });
  assert.equal(r.total, 2800);
  assert.equal(r.tarifaPorPagina, 700);
  assert.equal(r.paginas, 4);
  assert.equal(r.paginasEstimadas, false);
  const sin = calculatePrice(s);
  assert.equal(sin.total, 800);
  assert.equal(sin.paginasEstimadas, true);
});

test('el admin cambia las tarifas y el cálculo las usa enseguida', async () => {
  const cur = (await (await req('GET', 'hengi')).json()).rates;
  cur.foja.legal_simple = 275;
  cur.traduccion.tipos[0].tramos[0].precio = 750;
  const res = await req('PUT', 'admin', cur);
  assert.equal(res.status, 200);
  assert.equal(FOJA_RATES.legal_simple, 275);
  assert.equal(calculatePrice({ foja_tipo: 'legal_simple', fojas: 2 }).total, 550);
  assert.equal(rates.traduccionPrecio('carta_sencillo', 2).total, 1500);
  const log = (await pool.query(`SELECT category, summary FROM activity_log`)).rows;
  assert.equal(log.length, 1);
  assert.equal(log[0].category, 'precios');
  assert.match(log[0].summary, /tarifas/i);
});

test('un digitador no puede cambiar tarifas', async () => {
  const cur = (await (await req('GET', 'hengi')).json()).rates;
  assert.equal((await req('PUT', 'hengi', cur)).status, 403);
});

test('tarifas inválidas: 400 y no se guarda nada', async () => {
  const cur = (await (await req('GET', 'admin')).json()).rates;
  const malos = [
    { ...cur, foja: { ...cur.foja, legal_simple: -5 } },
    { ...cur, foja: { ...cur.foja, legal_simple: '' } },
    { ...cur, traduccion: { tipos: [{ ...cur.traduccion.tipos[0], tramos: [{ desde: 3, precio: 600 }] }] } },
    { ...cur, traduccion: { tipos: [{ ...cur.traduccion.tipos[0], tramos: [{ desde: 1, precio: 700 }, { desde: 1, precio: 600 }] }] } },
    { ...cur, traduccion: { tipos: [{ key: 'x', label: '', tramos: [{ desde: 1, precio: 700 }] }] } },
  ];
  for (const b of malos) assert.equal((await req('PUT', 'admin', b)).status, 400);
  assert.equal((await rates.getRates({ fresh: true })).foja.legal_simple, 250);
});

test('sin la tabla de tarifas se usan las de siempre y nada se cae', async () => {
  await pool.query('DROP TABLE pricing_rates');
  rates._reset();
  const r = await rates.refreshRates();
  assert.equal(r.foja.legal_simple, 250);
  assert.equal(rates.traduccionPrecio('carta_sencillo', 1).total, 700);
});

test('un tipo de traducción nuevo crea su servicio en el catálogo para que el bot lo cotice', async () => {
  const cur = (await (await req('GET', 'admin')).json()).rates;
  cur.traduccion.tipos.push({ key: 'carta_avanzada', label: 'Carta redacción avanzada', tramos: [{ desde: 1, precio: 1200 }, { desde: 3, precio: 1000 }] });
  assert.equal((await req('PUT', 'admin', cur)).status, 200);
  const s = await svc('Traducción - Carta redacción avanzada');
  assert.equal(s.traduccion_tipo, 'carta_avanzada');
  assert.equal(s.active, true);
  assert.equal(calculatePrice(s, { fojas: 3 }).total, 3000);
  // guardar otra vez no lo duplica
  await req('PUT', 'admin', cur);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM service_catalog WHERE traduccion_tipo = 'carta_avanzada'`)).rows[0].n, 1);
});

test('quitar un tipo desactiva su servicio; renombrar o cambiar el primer tramo actualiza el servicio', async () => {
  const cur = (await (await req('GET', 'admin')).json()).rates;
  cur.traduccion.tipos = cur.traduccion.tipos.filter((t) => t.key !== 'legal_denso');
  cur.traduccion.tipos[0].label = 'Carta sencilla';
  cur.traduccion.tipos[0].tramos[0].precio = 750;
  assert.equal((await req('PUT', 'admin', cur)).status, 200);
  assert.equal((await svc('Traducción - Legal extensivo o denso')).active, false);
  const s = (await pool.query(`SELECT * FROM service_catalog WHERE traduccion_tipo = 'carta_sencillo'`)).rows[0];
  assert.equal(s.name, 'Traducción - Carta sencilla');
  assert.equal(Number(s.digitacion_price), 750);
});

test('una traducción con un tipo que ya no existe queda por confirmar, sin precio viejo', async () => {
  await rates.refreshRates();
  const r = calculatePrice({ traduccion_tipo: 'borrado', digitacion_price: 900 }, { fojas: 2 });
  assert.equal(r.total, null);
  assert.equal(r.porConfirmar, true);
});

test('un error de la base no devuelve las tarifas a las de siempre', async () => {
  const cur = await rates.getRates({ fresh: true });
  await rates.saveRates({ ...cur, foja: { ...cur.foja, legal_simple: 300 } }, null);
  await pool.query('ALTER TABLE pricing_rates RENAME COLUMN value TO valor');
  try {
    const r = await rates.getRates({ fresh: true });
    assert.equal(r.foja.legal_simple, 300);
    assert.equal(FOJA_RATES.legal_simple, 300);
  } finally {
    await pool.query('ALTER TABLE pricing_rates RENAME COLUMN valor TO value');
  }
});

test('un cuerpo mal formado responde 400, no se queda colgado', async () => {
  const cur = (await (await req('GET', 'admin')).json()).rates;
  const res = await req('PUT', 'admin', { ...cur, traduccion: { tipos: [{ key: 'x_y', label: 'X', tramos: [null] }] } });
  assert.equal(res.status, 400);
});
