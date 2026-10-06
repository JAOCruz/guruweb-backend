const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

const WAIT = "Un miembro de nuestro equipo se comunicará con usted a la brevedad. ⏰ Horario de atención: Lunes a Viernes, 9:00 a 18:00 hrs. Si su asunto es urgente fuera de horario, por favor indíquelo escribiendo 'urgente'.";

test.beforeEach(async () => {
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS bot_tool_log, bot_memory, business_info, tramites, invoices, service_catalog CASCADE`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, digitacion_price NUMERIC, notarizacion_price NUMERIC, price_tiers JSONB, unit_type TEXT, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY)`);
});
test.after(async () => { await pool.end(); });

test('migration is idempotent and creates columns, tables, seed and bot user', async () => {
  await runSqlFile('migrations/20261005_bot_agent.sql');
  await runSqlFile('migrations/20261005_bot_agent.sql');
  const cols = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='service_catalog'`)).rows.map((r) => r.column_name);
  for (const c of ['descripcion','incluye','reglas','requisitos','alias','notarizacion','template_id','tiempo_entrega','por_confirmar','precio_rango']) assert.ok(cols.includes(c), c);
  for (const t of ['tramites','business_info','bot_memory','bot_tool_log']) {
    const r = await pool.query(`SELECT to_regclass($1) AS t`, [t]);
    assert.ok(r.rows[0].t, t);
  }
  const m = await pool.query(`SELECT valor FROM business_info WHERE clave='mensaje_espera'`);
  assert.equal(m.rows[0].valor, WAIT);
  assert.equal((await pool.query(`SELECT COUNT(*)::int n FROM business_info`)).rows[0].n, 7);
  const u = await pool.query(`SELECT is_active, in_payroll FROM users WHERE username='bot'`);
  assert.equal(u.rows.length, 1);
  assert.equal(u.rows[0].is_active, false);
});
