const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { getBusinessInfo, isOpen, formatForPrompt, clearCache } = require('../src/agent/businessInfo');

const H = { dias: [1,2,3,4,5], abre: '09:00', cierra: '18:00', zona: 'America/Santo_Domingo' };

test.beforeEach(async () => {
  clearCache();
  await resetDb();
  await runSqlFile('migrations/20260926_user_management.sql');
  await pool.query(`DROP TABLE IF EXISTS bot_tool_log, bot_memory, business_info, tramites, invoices, service_catalog CASCADE`);
  await pool.query(`CREATE TABLE service_catalog (id SERIAL PRIMARY KEY, name TEXT, description TEXT, digitacion_price NUMERIC, notarizacion_price NUMERIC, price_tiers JSONB, unit_type TEXT, active BOOLEAN DEFAULT true)`);
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY)`);
  await runSqlFile('migrations/20261005_bot_agent.sql');
});
test.after(async () => { await pool.end(); });

test('martes 10:00 en RD está abierto', () => assert.equal(isOpen(new Date('2026-10-06T14:00:00Z'), H), true));
test('martes 18:30 en RD está cerrado', () => assert.equal(isOpen(new Date('2026-10-06T22:30:00Z'), H), false));
test('martes 18:00 en RD está cerrado (cierre exclusivo)', () => assert.equal(isOpen(new Date('2026-10-06T22:00:00Z'), H), false));
test('martes 09:00 en RD está abierto (apertura inclusiva)', () => assert.equal(isOpen(new Date('2026-10-06T13:00:00Z'), H), true));
test('sábado al mediodía está cerrado', () => assert.equal(isOpen(new Date('2026-10-10T16:00:00Z'), H), false));

test('getBusinessInfo devuelve claves y cachea', async () => {
  const info = await getBusinessInfo();
  assert.equal(info.direccion, 'Av. Independencia 1607, Santo Domingo');
  assert.deepEqual(Object.keys(info).sort(), ['direccion','entregas','formas_pago','horario','mensaje_espera','temas_humano','trato']);
  await pool.query(`UPDATE business_info SET valor = to_jsonb('X'::text) WHERE clave='direccion'`);
  assert.equal((await getBusinessInfo()).direccion, 'Av. Independencia 1607, Santo Domingo');
  clearCache();
  assert.equal((await getBusinessInfo()).direccion, 'X');
});

test('formatForPrompt incluye la dirección y "transferencia o efectivo"', async () => {
  const txt = formatForPrompt(await getBusinessInfo());
  assert.ok(txt.includes('Av. Independencia 1607'));
  assert.ok(txt.includes('transferencia o efectivo'));
  assert.ok(txt.includes('9:00'));
});
