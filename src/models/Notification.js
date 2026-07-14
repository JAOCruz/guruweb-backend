const pool = require('../db/pool');

const Notification = {
  async create({ userId, type, title, message, link, metadata }) {
    const { rows } = await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, link, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [userId, type, title, message, link || null, metadata ? JSON.stringify(metadata) : '{}']
    );
    return rows[0];
  },

  async findByUser(userId, { onlyUnread = false, limit = 50 } = {}) {
    let query = 'SELECT * FROM notifications WHERE user_id = $1';
    const params = [userId];
    if (onlyUnread) {
      query += ' AND read = false';
    }
    query += ' ORDER BY created_at DESC LIMIT $2';
    params.push(limit);
    const { rows } = await pool.query(query, params);
    return rows;
  },

  async markRead(id, userId) {
    const { rows } = await pool.query(
      `UPDATE notifications
       SET read = true, read_at = NOW()
       WHERE id = $1 AND user_id = $2
       RETURNING *`,
      [id, userId]
    );
    return rows[0] || null;
  },

  async markAllRead(userId) {
    const { rowCount } = await pool.query(
      `UPDATE notifications
       SET read = true, read_at = NOW()
       WHERE user_id = $1 AND read = false`,
      [userId]
    );
    return rowCount;
  },

  async unreadCount(userId) {
    const { rows } = await pool.query(
      'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = false',
      [userId]
    );
    return parseInt(rows[0].count, 10);
  },
};

module.exports = Notification;
