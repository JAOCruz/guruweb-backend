const pool = require('../db/pool');

class SimulatorConversation {
  static async findOrCreate(sessionId, userId, title = 'Chat de prueba') {
    const existing = await this.findBySession(sessionId);
    if (existing) return existing;

    const { rows } = await pool.query(
      `INSERT INTO simulator_conversations (session_id, user_id, title)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [sessionId, userId, title]
    );
    return rows[0];
  }

  static async findBySession(sessionId) {
    const { rows } = await pool.query(
      'SELECT * FROM simulator_conversations WHERE session_id = $1',
      [sessionId]
    );
    return rows[0] || null;
  }

  static async findById(id) {
    const { rows } = await pool.query(
      'SELECT * FROM simulator_conversations WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  }

  static async findAllForAdmin({ status, limit = 50, offset = 0 } = {}) {
    let sql = `
      SELECT
        sc.*,
        COUNT(sm.id) AS message_count,
        MAX(sm.created_at) AS last_message_at
      FROM simulator_conversations sc
      LEFT JOIN simulator_messages sm ON sm.conversation_id = sc.id
    `;
    const params = [];
    if (status) {
      sql += ' WHERE sc.status = $1';
      params.push(status);
    }
    sql += ` GROUP BY sc.id ORDER BY sc.updated_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    const { rows } = await pool.query(sql, params);
    return rows;
  }

  static async updateNotes(id, { notes, status, title }) {
    const fields = [];
    const values = [];
    let idx = 1;

    if (notes !== undefined) {
      fields.push(`notes = $${idx++}`);
      values.push(notes);
    }
    if (status !== undefined) {
      fields.push(`status = $${idx++}`);
      values.push(status);
    }
    if (title !== undefined) {
      fields.push(`title = $${idx++}`);
      values.push(title);
    }
    if (fields.length === 0) return null;

    fields.push(`updated_at = NOW()`);
    values.push(id);

    const { rows } = await pool.query(
      `UPDATE simulator_conversations SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    return rows[0] || null;
  }
}

module.exports = SimulatorConversation;
