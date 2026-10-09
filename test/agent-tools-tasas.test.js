const { pool, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeProvider } = require('../src/agent/provider');
const { estimar_tasa } = require('../src/agent/tools/tasas');
const { TOOLS } = require('../src/agent/tools');

test.beforeEach(async () => {
  await resetDb();
  await pool.query(`DROP TABLE IF EXISTS tasas_cache`);
  await pool.query(`CREATE TABLE tasas_cache (id SERIAL PRIMARY KEY, concepto_key TEXT UNIQUE NOT NULL, concepto TEXT, monto NUMERIC, fuente TEXT, nota TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
});
test.after(async () => { await pool.end(); });

const mk = (fn) => { const calls = []; const p = createFakeProvider([], { search: async (r) => { calls.push(r); return fn(r); } }); return { p, calls }; };

test('estimar_tasa con búsqueda devuelve monto aproximado y lo guarda', async () => {
  const { p, calls } = mk(() => ({ text: 'Según DGII: {"monto":1500,"fuente":"https://dgii.gov.do/x","nota":"ok"}', sources: [] }));
  const r = await estimar_tasa({ concepto: 'Marbete' }, { provider: p });
  assert.equal(r.monto_aproximado, 1500);
  assert.equal(r.aproximado, true);
  assert.equal(r.fuente, 'https://dgii.gov.do/x');
  assert.match(r.fecha, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(calls[0].timeoutMs, 15000);
  const { rows } = await pool.query(`SELECT * FROM tasas_cache`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].concepto_key, 'marbete');
  assert.equal(Number(rows[0].monto), 1500);
});

test('segunda consulta igual sale de la caché sin buscar', async () => {
  const { p, calls } = mk(() => ({ text: '{"monto":1500}', sources: ['https://a.gob.do'] }));
  await estimar_tasa({ concepto: 'Marbete' }, { provider: p });
  const r = await estimar_tasa({ concepto: '  MARBETÉ ' }, { provider: p });
  assert.equal(calls.length, 1);
  assert.equal(r.monto_aproximado, 1500);
  assert.equal(r.fuente, 'https://a.gob.do');
});

test('caché vencida (31 días) vuelve a buscar', async () => {
  const { p, calls } = mk(() => ({ text: '{"monto":2000}', sources: [] }));
  await pool.query(`INSERT INTO tasas_cache (concepto_key, concepto, monto, created_at) VALUES ('marbete','Marbete',1500, NOW() - INTERVAL '31 days')`);
  const r = await estimar_tasa({ concepto: 'marbete' }, { provider: p });
  assert.equal(calls.length, 1);
  assert.equal(r.monto_aproximado, 2000);
  const { rows } = await pool.query(`SELECT monto FROM tasas_cache`);
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].monto), 2000);
});

test('sin search, con error QUOTA o respuesta sin monto → por_confirmar, sin lanzar', async () => {
  const esperado = { concepto: 'x', monto_aproximado: null, por_confirmar: true };
  assert.deepEqual(await estimar_tasa({ concepto: 'x' }, { provider: createFakeProvider([]) }), esperado);
  const quota = mk(() => { const e = new Error('Cuota'); e.code = 'QUOTA'; throw e; });
  assert.deepEqual(await estimar_tasa({ concepto: 'x' }, { provider: quota.p }), esperado);
  for (const text of ['no sé', '{"monto":null}', '{"monto":0}', '{"monto":-5}', '{roto']) {
    assert.deepEqual(await estimar_tasa({ concepto: 'x' }, { provider: mk(() => ({ text, sources: [] })).p }), esperado, text);
  }
  await pool.query(`DROP TABLE tasas_cache`);
  assert.deepEqual(await estimar_tasa({ concepto: 'x' }, { provider: mk(() => ({ text: '{"monto":5}', sources: [] })).p }), esperado);
});

test('estimar_tasa está registrada en TOOLS', () => {
  const t = TOOLS.find((x) => x.name === 'estimar_tasa');
  assert.ok(t);
  assert.deepEqual(t.parameters.required, ['concepto']);
});

test('monto con formato y JSON rodeado de prosa o llaves', async () => {
  const casos = [
    ['{"monto":"RD$1,500"}', 1500],
    ['El {marbete} cuesta: {"monto":900,"nota":"incluye } y {"}', 900],
    ['{"otro":1} luego {"monto":"2,250.50","fuente":"https://x.do"}', 2250.5],
  ];
  let i = 0;
  for (const [text, esperado] of casos) {
    const r = await estimar_tasa({ concepto: `c${i++}` }, { provider: mk(() => ({ text, sources: [] })).p });
    assert.equal(r.monto_aproximado, esperado, text);
  }
});

test('monto con punto de miles, coma de miles y porcentajes', async () => {
  const casos = [
    ['{"monto":"1.500"}', 1500],
    ['{"monto":"RD$1.500,00"}', 1500],
    ['{"monto":"1,500"}', 1500],
    ['{"monto":"12.345.678"}', 12345678],
    ['{"monto":"1500.75"}', 1500.75],
  ];
  let i = 0;
  for (const [text, esperado] of casos) {
    const r = await estimar_tasa({ concepto: `m${i++}` }, { provider: mk(() => ({ text, sources: [] })).p });
    assert.equal(r.monto_aproximado, esperado, text);
  }
  // Un porcentaje (impuesto de transferencia 2%) no es un monto en RD$: menos de 50 queda por confirmar y no se guarda.
  for (const text of ['{"monto":2,"nota":"2% del valor"}', '{"monto":"2"}', '{"monto":49}']) {
    const r = await estimar_tasa({ concepto: 'Impuesto de transferencia' }, { provider: mk(() => ({ text, sources: [] })).p });
    assert.deepEqual(r, { concepto: 'Impuesto de transferencia', monto_aproximado: null, por_confirmar: true }, text);
  }
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM tasas_cache WHERE concepto_key = 'impuesto de transferencia'`)).rows[0].n, 0);
});

test('el prompt pide que los porcentajes vayan en la nota, no en monto', async () => {
  const { p, calls } = mk(() => ({ text: '{"monto":null}', sources: [] }));
  await estimar_tasa({ concepto: 'Impuesto de transferencia' }, { provider: p });
  assert.match(calls[0].prompt, /porcentaje/i);
  assert.match(calls[0].prompt, /nota/);
});
