const { pool, runSqlFile } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');

test.after(async () => { await pool.end(); });

test('activity_log migration is idempotent and usable', async () => {
  await pool.query('DROP TABLE IF EXISTS activity_log');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await runSqlFile('migrations/20260927_activity_log.sql');
  await pool.query(`INSERT INTO activity_log (actor_id, actor_name, category, action, summary, details)
                    VALUES (1, 'admin', 'usuarios', 'user.create', 'Creó a Pedro', '{"a":1}')`);
  const { rows } = await pool.query('SELECT category, details FROM activity_log');
  assert.deepEqual(rows, [{ category: 'usuarios', details: { a: 1 } }]);
  const idx = (await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'activity_log'`)).rows.map((r) => r.indexname);
  assert.ok(idx.includes('activity_log_created_idx'));
  assert.ok(idx.includes('activity_log_actor_idx'));
  assert.ok(idx.includes('activity_log_category_idx'));
});
