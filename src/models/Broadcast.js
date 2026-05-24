const pool = require('../db/pool');

module.exports = {
  async create({ title, message, mediaUrl, scheduledAt, createdBy, recipients }) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO broadcasts (title, message, media_url, scheduled_at, created_by, recipient_count, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
        [title || null, message, mediaUrl || null, scheduledAt || null, createdBy, recipients.length]
      );
      const broadcast = rows[0];
      for (const r of recipients) {
        await client.query(
          `INSERT INTO broadcast_recipients (broadcast_id, client_id, phone, name) VALUES ($1, $2, $3, $4)`,
          [broadcast.id, r.client_id || null, r.phone, r.name || null]
        );
      }
      await client.query('COMMIT');
      return broadcast;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async findAll({ limit = 50 } = {}) {
    const { rows } = await pool.query(
      `SELECT b.*, u.name as created_by_name
       FROM broadcasts b
       LEFT JOIN users u ON u.id = b.created_by
       ORDER BY b.created_at DESC LIMIT $1`,
      [limit]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM broadcasts WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async getRecipients(broadcastId) {
    const { rows } = await pool.query(
      'SELECT * FROM broadcast_recipients WHERE broadcast_id = $1 ORDER BY id',
      [broadcastId]
    );
    return rows;
  },

  async markRecipientSent(id) {
    await pool.query(
      `UPDATE broadcast_recipients SET status = 'sent', sent_at = NOW() WHERE id = $1`, [id]
    );
  },

  async markRecipientFailed(id, error) {
    await pool.query(
      `UPDATE broadcast_recipients SET status = 'failed', error = $2 WHERE id = $1`, [id, error]
    );
  },

  async updateCounts(broadcastId) {
    await pool.query(`
      UPDATE broadcasts SET
        sent_count = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'sent'),
        failed_count = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = $1 AND status = 'failed')
      WHERE id = $1
    `, [broadcastId]);
  },

  async markSending(id) {
    await pool.query(`UPDATE broadcasts SET status = 'sending' WHERE id = $1`, [id]);
  },

  async markDone(id) {
    await pool.query(`UPDATE broadcasts SET status = 'done', sent_at = NOW() WHERE id = $1`, [id]);
  },

  async markFailed(id) {
    await pool.query(`UPDATE broadcasts SET status = 'failed', sent_at = NOW() WHERE id = $1`, [id]);
  },

  async cancel(id) {
    await pool.query(`UPDATE broadcasts SET status = 'cancelled' WHERE id = $1 AND status = 'pending'`, [id]);
  },

  async getPendingScheduled() {
    const { rows } = await pool.query(
      `SELECT * FROM broadcasts WHERE status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()`
    );
    return rows;
  },
};
