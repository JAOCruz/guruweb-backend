const pool = require('../config/database');
const bcrypt = require('bcryptjs');

class User {
  static async findByUsername(username) {
    const result = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    return result.rows[0];
  }

  static async findById(id) {
    const result = await pool.query(
      'SELECT id, username, role, data_column, created_at FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0];
  }

  static async create(username, password, role, dataColumn = null) {
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (username, password_hash, role, data_column) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, username, role, data_column, created_at`,
      [username, passwordHash, role, dataColumn]
    );
    return result.rows[0];
  }

  static async verifyPassword(plainPassword, hashedPassword) {
    return await bcrypt.compare(plainPassword, hashedPassword);
  }

  static async getAllEmployees() {
    const result = await pool.query(
      `SELECT id, username, role, data_column, created_at 
       FROM users 
       WHERE role = 'employee' 
       ORDER BY username`
    );
    return result.rows;
  }

  static async findByUsernameOrColumn(identifier) {
    const result = await pool.query(
      `SELECT * FROM users 
       WHERE LOWER(username) = LOWER($1) 
          OR UPPER(data_column) = UPPER($1)
       LIMIT 1`,
      [identifier]
    );
    return result.rows[0];
  }
}

module.exports = User;
