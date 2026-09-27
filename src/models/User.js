const pool = require('../db/pool');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;
const { COLOR_KEYS } = require('../config/appearance');
const { formatBirthDate } = require('../config/birthDate');

// Cases still in progress; resolved/closed/paid/cancelled ones keep their author
const OPEN_CASE = `status NOT IN ('resolved', 'closed', 'paid', 'cancelled')`;

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
      birthDate: formatBirthDate(user.birth_date),
    };
  },

  async updateBirthDate(id, birthDate) {
    const { rows } = await pool.query(
      'UPDATE users SET birth_date = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [birthDate, id]
    );
    return rows[0] || null;
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
              username, data_column, role, color, avatar, is_active, in_payroll
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
      `SELECT id, COALESCE(NULLIF(name, ''), NULLIF(data_column, ''), username) AS name,
              username, email, role, data_column, color, avatar, birth_date,
              is_active, in_payroll, must_change_password, last_seen, created_at, deactivated_at
       FROM users ${where}
       ORDER BY is_active DESC, COALESCE(NULLIF(name, ''), username) ASC`
    );
    return rows;
  },

  async adminCreate({ name, username, email, role, in_payroll, temp_password, birth_date = null }) {
    const passwordHash = await bcrypt.hash(temp_password, SALT_ROUNDS);
    const dataColumn = in_payroll ? await User.uniqueDataColumn(User.slugDataColumn(name)) : null;
    const { rows } = await pool.query(
      `INSERT INTO users (name, username, email, role, in_payroll, data_column, password_hash, must_change_password, birth_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
       RETURNING id`,
      [name, username, email || null, role, !!in_payroll, dataColumn, passwordHash, birth_date]
    );
    const id = rows[0].id;
    try {
      await User.assignFirstFreeColor(id);
    } catch (err) {
      console.error('[User.adminCreate] could not auto-assign color:', err.message);
    }
    return User.findById(id);
  },

  // birth_date undefined = keep the current value (older dashboards don't send it)
  async adminUpdate(id, { name, username, email, role, in_payroll, birth_date }) {
    const current = await User.findById(id);
    if (!current) return null;
    let dataColumn = current.data_column;
    if (in_payroll && !dataColumn) {
      dataColumn = await User.uniqueDataColumn(User.slugDataColumn(name || current.name));
    }
    const { rows } = await pool.query(
      `UPDATE users SET name = $1, username = $2, email = $3, role = $4, in_payroll = $5, data_column = $6,
              birth_date = CASE WHEN $8 THEN $9::date ELSE birth_date END, updated_at = NOW()
       WHERE id = $7 RETURNING *`,
      [name, username, email || null, role, !!in_payroll, dataColumn, id, birth_date !== undefined, birth_date ?? null]
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
              (SELECT COUNT(*) FROM cases WHERE user_id = $1 AND ${OPEN_CASE})::int AS cases`,
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

  // One transaction: move clients and open cases (with history), then lock the
  // account and free color/avatar. Finished cases keep their author.
  async deactivate(id, reassignTo, actorId = null) {
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
      const to = reassignTo ?? null;
      await client.query(
        `INSERT INTO client_assignment_history (client_id, from_user_id, to_user_id, assigned_by, notes)
         SELECT id, $1, $2, $3, 'Desactivación' FROM clients WHERE assigned_to = $1`,
        [id, to, actorId]
      );
      await client.query('UPDATE clients SET assigned_to = $1 WHERE assigned_to = $2', [to, id]);
      await client.query(
        `INSERT INTO case_assignment_history (case_id, from_user_id, to_user_id, assigned_by, notes)
         SELECT id, $1, $2, $3, 'Desactivación' FROM cases WHERE user_id = $1 AND ${OPEN_CASE}`,
        [id, to, actorId]
      );
      await client.query(`UPDATE cases SET user_id = $1 WHERE user_id = $2 AND ${OPEN_CASE}`, [to, id]);
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
