const { pool } = require('./db');

// Minimal clients/cases (+ assignment history) tables for assignment tests;
// production has many more columns and FKs.
async function resetAssignmentTables() {
  await pool.query('DROP TABLE IF EXISTS clients, cases, client_assignment_history, case_assignment_history CASCADE');
  await pool.query('CREATE TABLE clients (id SERIAL PRIMARY KEY, phone TEXT, assigned_to INT)');
  await pool.query(`CREATE TABLE cases (id SERIAL PRIMARY KEY, title TEXT, user_id INT, status TEXT NOT NULL DEFAULT 'open')`);
  await pool.query(`CREATE TABLE client_assignment_history (
    id SERIAL PRIMARY KEY, client_id INT NOT NULL, from_user_id INT, to_user_id INT, assigned_by INT,
    assigned_at TIMESTAMPTZ DEFAULT NOW(), notes TEXT)`);
  await pool.query(`CREATE TABLE case_assignment_history (
    id SERIAL PRIMARY KEY, case_id INT NOT NULL, from_user_id INT, to_user_id INT, assigned_by INT,
    assigned_at TIMESTAMPTZ DEFAULT NOW(), notes TEXT)`);
}

module.exports = { resetAssignmentTables };
