const fs = require('fs');
const path = require('path');

const LOCAL_URL = /^postgres(ql)?:\/\/([^@/]*@)?(localhost|127\.0\.0\.1)(:\d+)?\//;

// Nunca se muestran las credenciales: solo host y base.
function describeUrl(u) {
  const m = String(u).match(/^[a-z]+:\/\/(?:[^@/]*@)?([^/?#]*)\/?([^?#]*)/i);
  return m ? `${m[1]}/${m[2]}` : '(url inválida)';
}
function assertLocalUrl(u) {
  if (!LOCAL_URL.test(u)) throw new Error(`Refusing to run tests against non-local database: ${describeUrl(u)}`);
  return u;
}

const url = assertLocalUrl(process.env.TEST_DATABASE_URL || 'postgresql://localhost:5432/guru_test');
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

module.exports = { pool, runSqlFile, resetDb, assertLocalUrl };
