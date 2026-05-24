const pool = require('../db/pool');

const ClientMedia = {
  async create({ phone, clientId, waMessageId, mediaType, mimeType, originalName, savedName, filePath, fileSize, context, docRequestId }) {
    const { rows } = await pool.query(
      `INSERT INTO client_media (phone, client_id, wa_message_id, media_type, mime_type, original_name, saved_name, file_path, file_size, context, doc_request_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [phone, clientId || null, waMessageId || null, mediaType, mimeType || null, originalName || null, savedName, filePath, fileSize || null, context || 'conversation', docRequestId || null]
    );
    return rows[0];
  },

  async findByPhone(phone) {
    const { rows } = await pool.query(
      'SELECT * FROM client_media WHERE phone = $1 ORDER BY created_at DESC',
      [phone]
    );
    return rows;
  },

  async findByClient(clientId) {
    const { rows } = await pool.query(
      'SELECT * FROM client_media WHERE client_id = $1 ORDER BY created_at DESC',
      [clientId]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM client_media WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async linkToClient(phone, clientId) {
    const { rowCount } = await pool.query(
      'UPDATE client_media SET client_id = $1 WHERE phone = $2 AND client_id IS NULL',
      [clientId, phone]
    );
    return rowCount;
  },

  async linkToDocRequest(id, docRequestId) {
    const { rows } = await pool.query(
      `UPDATE client_media SET doc_request_id = $1, context = 'document_flow' WHERE id = $2 RETURNING *`,
      [docRequestId, id]
    );
    return rows[0] || null;
  },
};

module.exports = ClientMedia;
