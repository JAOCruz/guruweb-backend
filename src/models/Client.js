const pool = require('../db/pool');

const Client = {
  async create({ name, phone, email, address, notes, userId, source = 'whatsapp' }) {
    const { rows } = await pool.query(
      `INSERT INTO clients (name, phone, email, address, notes, user_id, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name, phone, email || null, address || null, notes || null, userId, source]
    );
    return rows[0];
  },

  async findAll() {
    const { rows } = await pool.query(
      'SELECT c.*, u.name AS assigned_to_name FROM clients c LEFT JOIN users u ON u.id = c.assigned_to ORDER BY c.created_at DESC'
    );
    return rows;
  },

  // Digitador: only clients assigned to them
  async findByAssignedTo(userId) {
    const { rows } = await pool.query(
      'SELECT c.*, u.name AS assigned_to_name FROM clients c LEFT JOIN users u ON u.id = c.assigned_to WHERE c.assigned_to = $1 ORDER BY c.created_at DESC',
      [userId]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query(
      'SELECT c.*, u.name AS assigned_name FROM clients c LEFT JOIN users u ON u.id = c.assigned_to WHERE c.id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async findByPhone(phone) {
    const { rows } = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone]);
    return rows[0] || null;
  },

  async update(id, fields) {
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE clients SET ${sets}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, id]
    );
    return rows[0] || null;
  },

  async delete(id) {
    const { rowCount } = await pool.query('DELETE FROM clients WHERE id = $1', [id]);
    return rowCount > 0;
  },

  async getDefaultUserId() {
    const { rows } = await pool.query('SELECT id FROM users ORDER BY id ASC LIMIT 1');
    return rows[0]?.id || null;
  },

  // Save WhatsApp display name for contacts. Prefer the richest name:
  // more words beats fewer words; longer beats shorter; existing beats empty.
  async updateOrCreatePushName(phone, pushName) {
    const { rows } = await pool.query(
      `INSERT INTO clients (phone, name, created_at, updated_at)
       VALUES ($1, $2, NOW(), NOW())
       ON CONFLICT (phone) DO UPDATE SET
         name = CASE
           WHEN clients.name IS NULL OR clients.name = '' THEN $2
           WHEN array_length(string_to_array($2, ' '), 1) > array_length(string_to_array(clients.name, ' '), 1) THEN $2
           WHEN length($2) > length(clients.name) THEN $2
           ELSE clients.name
         END,
         updated_at = NOW()
       RETURNING *`,
      [phone, pushName]
    );
    return rows[0];
  },

  // Update profile picture URL for a phone
  async updateProfilePic(phone, url) {
    const { rows } = await pool.query(
      `UPDATE clients
       SET profile_pic_url = $1, updated_at = NOW()
       WHERE phone = $2
       RETURNING *`,
      [url, phone]
    );
    return rows[0] || null;
  },
};

module.exports = Client;
