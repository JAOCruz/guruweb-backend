const pool = require('../db/pool');

const DocumentRequest = {
  async create({ clientId, caseId, docType, description, waMediaId, fileName, mimeType, notes, filePath, mediaId }) {
    const { rows } = await pool.query(
      `INSERT INTO document_requests (client_id, case_id, doc_type, description, wa_media_id, file_name, mime_type, notes, file_path, media_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [clientId, caseId || null, docType, description || null, waMediaId || null, fileName || null, mimeType || null, notes || null, filePath || null, mediaId || null]
    );
    return rows[0];
  },

  async findByClient(clientId) {
    const { rows } = await pool.query(
      'SELECT * FROM document_requests WHERE client_id = $1 ORDER BY created_at DESC',
      [clientId]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM document_requests WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async updateStatus(id, status, notes) {
    const params = [status, id];
    let query = 'UPDATE document_requests SET status = $1, updated_at = NOW()';
    if (notes !== undefined) {
      query += ', notes = $3';
      params.push(notes);
    }
    query += ' WHERE id = $2 RETURNING *';
    const { rows } = await pool.query(query, params);
    return rows[0] || null;
  },
};

module.exports = DocumentRequest;
