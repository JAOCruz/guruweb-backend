const pool = require('../db/pool');

const SESSION_TTL_MINUTES = 30;

const ConversationSession = {
  async findActive(phone) {
    const { rows } = await pool.query(
      `SELECT * FROM conversation_sessions
       WHERE phone = $1 AND active = true AND expires_at > NOW()
       ORDER BY updated_at DESC LIMIT 1`,
      [phone]
    );
    return rows[0] || null;
  },

  async create(phone, clientId = null) {
    const { rows } = await pool.query(
      `INSERT INTO conversation_sessions (phone, client_id, flow, step, data, expires_at)
       VALUES ($1, $2, 'main_menu', 'init', '{}', NOW() + INTERVAL '${SESSION_TTL_MINUTES} minutes')
       RETURNING *`,
      [phone, clientId]
    );
    return rows[0];
  },

  async update(id, { flow, step, data }) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (flow !== undefined) { fields.push(`flow = $${idx++}`); values.push(flow); }
    if (step !== undefined) { fields.push(`step = $${idx++}`); values.push(step); }
    if (data !== undefined) { fields.push(`data = $${idx++}`); values.push(JSON.stringify(data)); }

    fields.push(`expires_at = NOW() + INTERVAL '${SESSION_TTL_MINUTES} minutes'`);
    fields.push('updated_at = NOW()');

    values.push(id);
    const { rows } = await pool.query(
      `UPDATE conversation_sessions SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  },

  async setClientId(id, clientId) {
    const { rows } = await pool.query(
      'UPDATE conversation_sessions SET client_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [clientId, id]
    );
    return rows[0] || null;
  },

  async close(id) {
    await pool.query(
      'UPDATE conversation_sessions SET active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );
  },

  async expireOld() {
    await pool.query(
      "UPDATE conversation_sessions SET active = false WHERE active = true AND expires_at < NOW()"
    );
  },
};

module.exports = ConversationSession;
