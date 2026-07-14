const pool = require('../db/pool');

const ClientDocument = {
  async create({
    clientId,
    caseId = null,
    docGenerationSessionId = null,
    templateId = null,
    versionNumber = 1,
    filePath = null,
    fileName,
    generatedByUserId = null,
    status = 'active',
    notes = null,
    parentDocumentId = null,
    storageType = 'local',
    s3Key = null,
    s3Url = null,
  }) {
    const { rows } = await pool.query(
      `INSERT INTO client_documents
        (client_id, case_id, doc_generation_session_id, template_id, version_number,
         file_path, file_name, generated_by_user_id, status, notes, parent_document_id,
         storage_type, s3_key, s3_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [clientId, caseId, docGenerationSessionId, templateId, versionNumber,
       filePath, fileName, generatedByUserId, status, notes, parentDocumentId,
       storageType, s3Key, s3Url]
    );
    return rows[0];
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT d.*,
        c.name AS client_name, t.name AS template_name,
        u.name AS generated_by_name
       FROM client_documents d
       LEFT JOIN clients c ON c.id = d.client_id
       LEFT JOIN doc_templates t ON t.id = d.template_id
       LEFT JOIN users u ON u.id = d.generated_by_user_id
       WHERE d.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async findByClientId(clientId) {
    const { rows } = await pool.query(
      `SELECT d.*,
        c.name AS client_name, t.name AS template_name,
        u.name AS generated_by_name
       FROM client_documents d
       LEFT JOIN clients c ON c.id = d.client_id
       LEFT JOIN doc_templates t ON t.id = d.template_id
       LEFT JOIN users u ON u.id = d.generated_by_user_id
       WHERE d.client_id = $1
       ORDER BY d.created_at DESC`,
      [clientId]
    );
    return rows;
  },

  async findByCaseId(caseId) {
    const { rows } = await pool.query(
      `SELECT d.*,
        c.name AS client_name, t.name AS template_name,
        u.name AS generated_by_name
       FROM client_documents d
       LEFT JOIN clients c ON c.id = d.client_id
       LEFT JOIN doc_templates t ON t.id = d.template_id
       LEFT JOIN users u ON u.id = d.generated_by_user_id
       WHERE d.case_id = $1
       ORDER BY d.created_at DESC`,
      [caseId]
    );
    return rows;
  },

  async getLatestVersion(clientId, templateId, caseId = null) {
    const { rows } = await pool.query(
      `SELECT MAX(version_number) AS max_version
       FROM client_documents
       WHERE client_id = $1 AND template_id = $2 AND COALESCE(case_id, 0) = COALESCE($3, 0)`,
      [clientId, templateId, caseId]
    );
    return rows[0]?.max_version || 0;
  },

  async findVersions(parentDocumentId) {
    const { rows } = await pool.query(
      `WITH RECURSIVE versions AS (
        SELECT * FROM client_documents WHERE id = $1
        UNION ALL
        SELECT d.* FROM client_documents d
        INNER JOIN versions v ON v.parent_document_id = d.id
      )
      SELECT * FROM versions ORDER BY version_number`,
      [parentDocumentId]
    );
    return rows;
  },

  async updateStatus(id, status) {
    const { rows } = await pool.query(
      `UPDATE client_documents SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return rows[0] || null;
  },

  async addNote(id, note) {
    const { rows } = await pool.query(
      `UPDATE client_documents
       SET notes = COALESCE(notes, '') || E'\n' || $1
       WHERE id = $2 RETURNING *`,
      [note, id]
    );
    return rows[0] || null;
  },
};

module.exports = ClientDocument;
