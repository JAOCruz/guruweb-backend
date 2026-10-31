// Las dos migraciones del 2025-08-15 reescriben invoices_status_check y la de "reject" corre después y quita
// 'pending_approval': las cotizaciones del bot fallaban con 23514 y el chat pasaba a una persona (2026-10-31).
const { pool, runSqlFile } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

const MIG = 'migrations/20261031_estado_por_aprobar.sql';

test.before(async () => {
  await pool.query('DROP TABLE IF EXISTS invoices CASCADE');
  await pool.query(`CREATE TABLE invoices (id SERIAL PRIMARY KEY, status VARCHAR(20) DEFAULT 'draft',
    CONSTRAINT invoices_status_check CHECK (status IN ('draft', 'approved', 'sent', 'paid', 'cancelled', 'rejected')))`);
  await pool.query(`INSERT INTO invoices (status) VALUES ('draft'), ('paid'), ('rejected')`);
  await runSqlFile(MIG);
  await runSqlFile(MIG); // idempotente
});
test.after(() => pool.end());

test('después de la migración una cotización puede quedar por aprobar', async () => {
  await pool.query(`UPDATE invoices SET status = 'pending_approval' WHERE status = 'draft'`);
  assert.equal((await pool.query(`SELECT count(*)::int n FROM invoices WHERE status = 'pending_approval'`)).rows[0].n, 1);
});

test('los estados de siempre siguen valiendo y uno inventado no', async () => {
  for (const s of ['draft', 'approved', 'sent', 'paid', 'cancelled', 'rejected']) await pool.query('INSERT INTO invoices (status) VALUES ($1)', [s]);
  await assert.rejects(pool.query(`INSERT INTO invoices (status) VALUES ('otro')`), { code: '23514' });
});
