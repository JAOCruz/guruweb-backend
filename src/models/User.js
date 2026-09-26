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
      isActive: user.is_active !== false,
      mustChangePassword: user.must_change_password === true,
      inPayroll: user.in_payroll === true,
    };
  },

  async clearMustChangePassword(id) {
    await pool.query('UPDATE users SET must_change_password = FALSE, updated_at = NOW() WHERE id = $1', [id]);
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

  // ── Admin user management ──

  slugDataColumn(name) {
    return (name || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  },

  async uniqueDataColumn(base) {
    const root = base || 'EMPLEADO';
    let candidate = root;
    for (let n = 2; ; n++) {
      const { rows } = await pool.query('SELECT 1 FROM users WHERE UPPER(data_column) = $1', [candidate]);
      if (!rows.length) return candidate;
      candidate = `${root}_${n}`;
    }
  },

  async adminList(status = 'all') {
    const where = status === 'active' ? 'WHERE is_active = TRUE'
      : status === 'inactive' ? 'WHERE is_active = FALSE'
      : '';
    const { rows } = await pool.query(
      `SELECT id, name, username, email, role, data_column, color, avatar,
              is_active, in_payroll, must_change_password, last_seen, created_at, deactivated_at
       FROM users ${where}
       ORDER BY is_active DESC, COALESCE(NULLIF(name, ''), username) ASC`
    );
    return rows;
  },

  async adminCreate({ name, username, email, role, in_payroll, temp_password }) {
    const passwordHash = await bcrypt.hash(temp_password, SALT_ROUNDS);
    const dataColumn = in_payroll ? await User.uniqueDataColumn(User.slugDataColumn(name)) : null;
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, email, role, in_payroll, data_column, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
       RETURNING id`,
      [name, username, email || null, role, !!in_payroll, dataColumn, passwordHash]
    );
    const id = rows[0].id;
    try {
      await User.assignFirstFreeColor(id);
    } catch (err) {
      console.error('[User.adminCreate] could not auto-assign color:', err.message);
    }
    return User.findById(id);
  },

  async adminUpdate(id, { name, username, email, role, in_payroll }) {
    const current = await User.findById(id);
    if (!current) return null;
    let dataColumn = current.data_column;
    if (in_payroll && !dataColumn) {
      dataColumn = await User.uniqueDataColumn(User.slugDataColumn(name || current.name));
    }
    const { rows } = await pool.query(
      `UPDATE users SET name = $1, username = $2, email = $3, role = $4, in_payroll = $5, data_column = $6, updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [name, username, email || null, role, !!in_payroll, dataColumn, id]
    );
    return rows[0] || null;
  },

  async setTempPassword(id, password) {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const { rows } = await pool.query(
      `UPDATE users SET password_hash = $1, must_change_password = TRUE, updated_at = NOW()
       WHERE id = $2 RETURNING *`,
      [passwordHash, id]
    );
    return rows[0] || null;
  },

  async countAssignments(id) {
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM clients WHERE assigned_to = $1)::int AS clients,
              (SELECT COUNT(*) FROM cases WHERE user_id = $1)::int AS cases`,
      [id]
    );
    return rows[0];
  },

  async countActiveAdmins(excludeId = null) {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM users
       WHERE role = 'admin' AND is_active = TRUE AND ($1::int IS NULL OR id <> $1)`,
      [excludeId]
    );
    return rows[0].n;
  },

  // One transaction: move assignments, then lock the account and free color/avatar
  async deactivate(id, reassignTo) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (reassignTo != null) {
        const { rows } = await client.query(
          'SELECT id FROM users WHERE id = $1 AND is_active = TRUE AND id <> $2',
          [reassignTo, id]
        );
        if (!rows.length) {
          const err = new Error('INVALID_REASSIGN');
          err.code = 'INVALID_REASSIGN';
          throw err;
        }
      }
      await client.query('UPDATE clients SET assigned_to = $1 WHERE assigned_to = $2', [reassignTo ?? null, id]);
      await client.query('UPDATE cases SET user_id = $1 WHERE user_id = $2', [reassignTo ?? null, id]);
      const { rows } = await client.query(
        `UPDATE users SET is_active = FALSE, deactivated_at = NOW(), color = NULL, avatar = NULL, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [id]
      );
      await client.query('COMMIT');
      return rows[0] || null;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  async reactivate(id) {
    await pool.query(
      `UPDATE users SET is_active = TRUE, deactivated_at = NULL, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    try {
      await User.assignFirstFreeColor(id);
    } catch (err) {
      console.error('[User.reactivate] could not assign color:', err.message);
    }
    return User.findById(id);
  },
};

module.exports = User;
