const pool = require('../db/pool');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;

const User = {
  async create({ email, password, name, role = 'lawyer', username, data_column }) {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, username, data_column)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, name, role, username, data_column, created_at`,
      [email, passwordHash, name, role, username || null, data_column || null]
    );
    return rows[0];
  },

  async findByEmail(email) {
    try {
      const { rows } = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
      );
      return rows[0] || null;
    } catch (err) {
      // Fallback for old schema (email column missing)
      if (err.message && err.message.includes('email')) {
        return null;
      }
      throw err;
    }
  },

  async findByUsername(username) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE username = $1',
      [username]
    );
    return rows[0] || null;
  },

  async findByUsernameOrEmail(identifier) {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM users
         WHERE LOWER(username) = LOWER($1)
            OR LOWER(email) = LOWER($1)
            OR UPPER(data_column) = UPPER($1)
         LIMIT 1`,
        [identifier]
      );
      return rows[0] || null;
    } catch (err) {
      // Fallback for old schema (email column missing)
      if (err.message && err.message.includes('email')) {
        const { rows } = await pool.query(
          `SELECT * FROM users
           WHERE LOWER(username) = LOWER($1)
              OR UPPER(data_column) = UPPER($1)
           LIMIT 1`,
          [identifier]
        );
        return rows[0] || null;
      }
      throw err;
    }
  },

  async findById(id) {
    const { rows } = await pool.query(
      'SELECT id, email, name, role, username, data_column, created_at, updated_at FROM users WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async getAllEmployees() {
    const { rows } = await pool.query(
      `SELECT id, username, email, name, role, data_column, created_at
       FROM users
       WHERE role = 'employee'
       ORDER BY username`
    );
    return rows;
  },

  async verifyPassword(plaintext, hash) {
    return bcrypt.compare(plaintext, hash);
  },

  async findByUsernameOrColumn(identifier) {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM users
         WHERE LOWER(username) = LOWER($1)
            OR UPPER(data_column) = UPPER($1)
         LIMIT 1`,
        [identifier]
      );
      return rows[0] || null;
    } catch (err) {
      throw err;
    }
  },
};

module.exports = User;
