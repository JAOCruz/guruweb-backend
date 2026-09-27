const { pool, runSqlFile, resetDb } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const activity = require('../src/services/activityLog');

const req = (id, username) => ({ user: { id, username }, ip: '1.2.3.4' });

test.beforeEach(async () => {
  await resetDb();
  await pool.query(`INSERT INTO users (username, password_hash, name, role) VALUES ('admin','x','Admin','admin'), ('hengi','x','Hengi','digitador')`);
  await runSqlFile('migrations/20260926_user_appearance.sql');
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
});
test.after(async () => { await pool.end(); });

test('logs an action with actor, ip and details', async () => {
  await activity.logActivity(req(1, 'admin'), { category: 'usuarios', action: 'user.create', entityType: 'user', entityId: 9, summary: 'Creó el usuario pedro', details: { role: 'digitador' } });
  const { rows } = await pool.query('SELECT actor_id, actor_name, category, action, entity_type, entity_id, summary, details, ip FROM activity_log');
  assert.deepEqual(rows[0], { actor_id: 1, actor_name: 'admin', category: 'usuarios', action: 'user.create', entity_type: 'user', entity_id: '9', summary: 'Creó el usuario pedro', details: { role: 'digitador' }, ip: '1.2.3.4' });
});

test('never stores secrets in details', async () => {
  await activity.logActivity(req(1, 'admin'), { category: 'seguridad', action: 'x', summary: 's', details: { password: 'a', nested: { temp_password: 'b', newPassword: 'c', turnstileToken: 'd', ok: 1 }, currentPassword: 'e' } });
  const { rows } = await pool.query('SELECT details FROM activity_log');
  assert.deepEqual(rows[0].details, { nested: { ok: 1 } });
});

test('a logging failure never throws', async () => {
  await pool.query('DROP TABLE activity_log');
  await assert.doesNotReject(activity.logActivity(req(1, 'admin'), { category: 'usuarios', action: 'x', summary: 's' }));
});

test('lists newest first with filters and pagination', async () => {
  const add = (actorId, name, category, summary, daysAgo) => pool.query(
    `INSERT INTO activity_log (actor_id, actor_name, category, action, summary, created_at) VALUES ($1,$2,$3,'a',$4, NOW() - ($5 || ' days')::interval)`,
    [actorId, name, category, summary, String(daysAgo)]);
  await add(1, 'admin', 'usuarios', 'Creó a Pedro', 3);
  await add(2, 'hengi', 'facturas', 'Creó la factura FAC-1', 2);
  await add(1, 'admin', 'facturas', 'Aprobó la factura FAC-1', 1);

  const all = await activity.listActivity({});
  assert.equal(all.total, 3);
  assert.deepEqual(all.items.map((i) => i.summary), ['Aprobó la factura FAC-1', 'Creó la factura FAC-1', 'Creó a Pedro']);
  assert.equal(all.items[0].actor_display_name, 'Admin');

  assert.equal((await activity.listActivity({ category: 'facturas' })).total, 2);
  assert.equal((await activity.listActivity({ actorId: 2 })).total, 1);
  assert.equal((await activity.listActivity({ q: 'pedro' })).total, 1);
  const from = new Date(Date.now() - 2.5 * 86400000).toISOString();
  assert.equal((await activity.listActivity({ from })).total, 2);

  const page2 = await activity.listActivity({ page: 2, pageSize: 2 });
  assert.deepEqual(page2.items.map((i) => i.summary), ['Creó a Pedro']);
});

test('purgeOld removes entries older than a year only', async () => {
  await pool.query(`INSERT INTO activity_log (category, action, summary, created_at) VALUES ('usuarios','a','viejo', NOW() - interval '400 days'), ('usuarios','a','nuevo', NOW() - interval '10 days')`);
  assert.equal(await activity.purgeOld(365), 1);
  const { rows } = await pool.query('SELECT summary FROM activity_log');
  assert.deepEqual(rows.map((r) => r.summary), ['nuevo']);
});
