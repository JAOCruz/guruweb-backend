// Apostilla en Cancillería (Leandro, 2026-10-26): es una gestión, se cotiza uno o varios impuestos
// y la Cancillería responde en 8 a 24 horas laborables. La migración solo toca esas frases.
const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

const MIG = 'migrations/20261026_apostilla_cancilleria.sql';

test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query('DROP TABLE IF EXISTS service_catalog, invoices, tramites, business_info CASCADE');
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, digitacion_price NUMERIC, notarizacion_price NUMERIC, price_tiers JSONB, unit_type TEXT, active BOOLEAN DEFAULT true)`);
  await pool.query('CREATE TABLE invoices (id SERIAL PRIMARY KEY)');
  await runSqlFile('migrations/20261005_bot_agent.sql');
  await pool.query(`INSERT INTO service_catalog (name, reglas, tiempo_entrega) VALUES
    ('Apostilla en Cancillería', 'Pregunte para qué país van.', 'De 4 a 48 horas'), ('Copia', 'Sin cambios.', '5 minutos')`);
  await pool.query(`INSERT INTO tramites (nombre, reglas) VALUES
    ('Apostilla de documento', 'Se agenda con 48 horas; la Cancillería suele responder en 24 horas o más, según el estado de los documentos.')`);
  await pool.query(`INSERT INTO business_info (clave, valor) VALUES ('tiempos_entrega', '[{"servicio": "Impresión", "tiempo": "inmediata"}]')
    ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`);
});
test.after(() => pool.end());

const apostilla = async () =>
  (await pool.query(`SELECT descripcion, reglas, tiempo_entrega FROM service_catalog WHERE name = 'Apostilla en Cancillería'`)).rows[0];

test('la apostilla queda como gestión, con impuestos según el caso y 8 a 24 horas laborables', async () => {
  await runSqlFile(MIG);
  const a = await apostilla();
  assert.match(a.descripcion, /^Gestión de la solicitud de apostilla/);
  assert.match(a.tiempo_entrega, /8 a 24 horas laborables/);
  assert.ok(a.reglas.startsWith('Pregunte para qué país van. Es una gestión'), 'conserva lo que ya había');
  assert.match(a.reglas, /uno o varios impuestos/);
  const t = (await pool.query(`SELECT reglas FROM tramites WHERE nombre = 'Apostilla de documento'`)).rows[0].reglas;
  assert.match(t, /responde en 8 a 24 horas laborables/);
  const tiempos = (await pool.query(`SELECT valor FROM business_info WHERE clave = 'tiempos_entrega'`)).rows[0].valor;
  assert.deepEqual(tiempos.map((x) => x.servicio), ['Impresión', 'Apostilla en Cancillería']);
  assert.equal((await pool.query(`SELECT reglas FROM service_catalog WHERE name = 'Copia'`)).rows[0].reglas, 'Sin cambios.');
});

test('correrla dos veces no repite nada', async () => {
  await runSqlFile(MIG);
  const first = await apostilla();
  await runSqlFile(MIG);
  assert.deepEqual(await apostilla(), first);
  const tiempos = (await pool.query(`SELECT valor FROM business_info WHERE clave = 'tiempos_entrega'`)).rows[0].valor;
  assert.equal(tiempos.length, 2);
});
