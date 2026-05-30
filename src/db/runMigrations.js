const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getExecutedMigrations() {
  const { rows } = await pool.query(
    `SELECT filename FROM schema_migrations ORDER BY executed_at`
  );
  return new Set(rows.map((r) => r.filename));
}

async function runMigration(filename, sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
      [filename]
    );
    await client.query('COMMIT');
    console.log(`✅ Migration executed: ${filename}`);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ Migration failed: ${filename}`);
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  try {
    await ensureMigrationsTable();
    const executed = await getExecutedMigrations();

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found.');
      return;
    }

    let ran = 0;
    for (const file of files) {
      if (executed.has(file)) {
        console.log(`⏭️  Skipped (already executed): ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      await runMigration(file, sql);
      ran++;
    }

    if (ran === 0) {
      console.log('All migrations are already up to date.');
    } else {
      console.log(`\n🎉 ${ran} migration(s) applied successfully.`);
    }

    process.exit(0);
  } catch (err) {
    console.error('\n💥 Migration runner failed:', err.message);
    process.exit(1);
  }
}

main();
