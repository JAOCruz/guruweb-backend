const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const MIGRATIONS_DIR = path.join(__dirname, '../../migrations');

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getExecutedMigrations(client) {
  const { rows } = await client.query(
    `SELECT filename FROM schema_migrations ORDER BY executed_at`
  );
  return new Set(rows.map((r) => r.filename));
}

async function runMigration(client, filename, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
      [filename]
    );
    await client.query('COMMIT');
    console.log(`✅ Migration executed: ${filename}`);
    return { filename, status: 'executed' };
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`❌ Migration failed: ${filename}`);
    throw err;
  }
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const executed = await getExecutedMigrations(client);

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    if (files.length === 0) {
      console.log('No migration files found.');
      return { ran: [], skipped: [] };
    }

    const ran = [];
    const skipped = [];
    for (const file of files) {
      if (executed.has(file)) {
        console.log(`⏭️  Skipped (already executed): ${file}`);
        skipped.push(file);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf-8');
      const result = await runMigration(client, file, sql);
      ran.push(result);
    }

    if (ran.length === 0) {
      console.log('All migrations are already up to date.');
    } else {
      console.log(`\n🎉 ${ran.length} migration(s) applied successfully.`);
    }

    return { ran, skipped };
  } finally {
    client.release();
  }
}

// CLI entry point
async function main() {
  try {
    await runMigrations();
    process.exit(0);
  } catch (err) {
    console.error('\n💥 Migration runner failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runMigrations };
