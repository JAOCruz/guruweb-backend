const pool = require('../db/pool');

class SimulatorMessage {
  static async create({
    conversationId,
    role,
    text,
    mediaType,
    mediaOriginalName,
    mediaAnalysis,
  }) {
    const { rows } = await pool.query(
      `INSERT INTO simulator_messages
         (conversation_id, role, text, media_type, media_original_name, media_analysis)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [conversationId, role, text, mediaType, mediaOriginalName, mediaAnalysis]
    );
    return rows[0];
  }

  static async findByConversation(conversationId) {
    const { rows } = await pool.query(
      `SELECT * FROM simulator_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [conversationId]
    );
    return rows;
  }

  static async findById(id) {
    const { rows } = await pool.query(
      'SELECT * FROM simulator_messages WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  }

  static async updateFeedback(id, { feedback, rating }) {
    const { rows } = await pool.query(
      `UPDATE simulator_messages
       SET feedback = $1, rating = $2
       WHERE id = $3
       RETURNING *`,
      [feedback, rating, id]
    );
    return rows[0] || null;
  }
}

module.exports = SimulatorMessage;
