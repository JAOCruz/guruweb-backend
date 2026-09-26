const { pool } = require('./db');

// Minimal clients/cases tables for assignment tests (production has many more columns)
async function resetAssignmentTables() {
  await pool.query('DROP TABLE IF EXISTS clients, cases CASCADE');
  await pool.query('CREATE TABLE clients (id SERIAL PRIMARY KEY, phone TEXT, assigned_to INT)');
  await pool.query('CREATE TABLE cases (id SERIAL PRIMARY KEY, title TEXT, user_id INT)');
}

module.exports = { resetAssignmentTables };
