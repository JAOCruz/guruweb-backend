const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Database configuration from environment or defaults
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'guruweb',
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'secure_password_change_me',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false // Railway uses SSL
});

async function runMigration(migrationFile) {
  const client = await pool.connect();

  try {
    console.log(`Running migration: ${migrationFile}`);

    const migrationPath = path.join(__dirname, '../migrations', migrationFile);
    const migrationSQL = fs.readFileSync(migrationPath, 'utf8');

    await client.query('BEGIN');
    await client.query(migrationSQL);
    await client.query('COMMIT');

    console.log(`✓ Migration ${migrationFile} completed successfully`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error(`✗ Migration ${migrationFile} failed:`, error.message);
    throw error;
  } finally {
    client.release();
  }
}

async function runAllMigrations() {
  try {
    const migrationsDir = path.join(__dirname, '../migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter(file => file.endsWith('.sql'))
      .sort(); // Run in alphabetical order

    console.log(`Found ${files.length} migration(s) to run\n`);

    for (const file of files) {
      await runMigration(file);
    }

    console.log('\n✓ All migrations completed successfully');
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Migration failed:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run migrations
runAllMigrations();
