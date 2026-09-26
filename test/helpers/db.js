const fs = require('fs');
const path = require('path');

const url = process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/guru_test';
if (!/@?(localhost|127\.0\.0\.1)(:\d+)?\//.test(url)) {
  throw new Error(`Refusing to run tests against non-local database: ${url}`);
}
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';

const pool = require('../../src/db/pool');

async function runSqlFile(relPath) {
  const sql = fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
  await pool.query(sql);
}

async function resetDb() {
  await pool.query('DROP TABLE IF EXISTS users CASCADE');
  await runSqlFile('test/fixtures/users_schema.sql');
}

module.exports = { pool, runSqlFile, resetDb };
