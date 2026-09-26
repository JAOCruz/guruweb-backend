const pool = require('../db/pool');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;
const { COLOR_KEYS } = require('../config/appearance');

const User = {
  async create({ email, password, name, role = 'digitador', username, data_column }) {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, name, role, username, data_column)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, name, role, username, data_column, color, avatar, created_at`,
      [email, passwordHash, name, role, username || null, data_column || null]
    );
    const user = rows[0];
    try {
      user.color = await User.assignFirstFreeColor(user.id);
    } catch (err) {
      console.error('[User.create] could not auto-assign color:', err.message);
    }
    return user;
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
    try {
      const { rows } = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [id]
      );
      return rows[0] || null;
    } catch (err) {
      throw err;
    }
  },

  async getAllEmployees() {
    try {
      const { rows } = await pool.query(
        `SELECT * FROM users WHERE role != 'admin' ORDER BY username`
      );
      return rows;
    } catch (err) {
      throw err;
    }
  },

  async verifyPassword(plaintext, hash) {
    return bcrypt.compare(plaintext, hash);
  },

  async updatePassword(userId, newPassword) {
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    const { rows } = await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2
       RETURNING id, username, email, name, role`,
      [passwordHash, userId]
    );
    return rows[0] || null;
  },

  async updatePasswordByUsername(username, newPassword) {
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    const { rows } = await pool.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE username = $2
       RETURNING id, username, email, name, role`,
      [passwordHash, username]
    );
    return rows[0] || null;
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

  toPublicUser(user) {
    return {
      id: user.id,
      username: user.username || user.email,
      email: user.email || user.username,
      name: user.name || user.username,
      role: user.role,
      dataColumn: user.data_column,
      color: user.color || null,
      avatar: user.avatar || null,
    };
  },

  async assignFirstFreeColor(id) {
    const { rows } = await pool.query(
      `UPDATE users SET color = (
         SELECT p.c FROM unnest($2::text[]) WITH ORDINALITY AS p(c, ord)
         WHERE p.c NOT IN (SELECT color FROM users WHERE color IS NOT NULL)
         ORDER BY p.ord LIMIT 1)
       WHERE id = $1 AND color IS NULL
       RETURNING color`,
      [id, COLOR_KEYS]
    );
    return rows[0]?.color ?? null;
  },

  async updateAppearance(id, { color, avatar }) {
    const sets = [];
    const values = [];
    if (color !== undefined) { values.push(color); sets.push(`color = $${values.length}`); }
    if (avatar !== undefined) { values.push(avatar); sets.push(`avatar = $${values.length}`); }
    if (sets.length === 0) return User.findById(id);
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE users SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async listDirectory() {
    const { rows } = await pool.query(
      `SELECT id,
              COALESCE(NULLIF(name, ''), NULLIF(data_column, ''), username) AS name,
              username, data_column, role, color, avatar
       FROM users
       ORDER BY id`
    );
    return rows;
  },
};

module.exports = User;
