const pool = require('../db/pool');

const Case = {
  async create({ caseNumber, title, description, caseType, clientId, userId, court, nextHearing }) {
    const { rows } = await pool.query(
      `INSERT INTO cases (case_number, title, description, case_type, client_id, user_id, court, next_hearing)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [caseNumber, title, description || null, caseType || null, clientId, userId, court || null, nextHearing || null]
    );
    return rows[0];
  },

  async findAll({ status, clientId, caseType } = {}) {
    let query = `SELECT c.*, cl.name as client_name, cl.phone as client_phone FROM cases c
                 LEFT JOIN clients cl ON c.client_id = cl.id WHERE 1=1`;
    const params = [];
    if (status) {
      params.push(status);
      query += ` AND c.status = $${params.length}`;
    }
    if (clientId) {
      params.push(clientId);
      query += ` AND c.client_id = $${params.length}`;
    }
    if (caseType) {
      params.push(caseType);
      query += ` AND c.case_type = $${params.length}`;
    }
    query += ' ORDER BY c.created_at DESC';
    const { rows } = await pool.query(query, params);

    const cases = [];
    for (const caseRow of rows) {
      const tagRows = await pool.query(
        'SELECT tag_type, tag_value FROM case_tags WHERE case_id = $1',
        [caseRow.id]
      );
      cases.push({
        ...caseRow,
        tags: tagRows.rows,
      });
    }
    return cases;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM cases WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async update(id, fields) {
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE cases SET ${sets}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, id]
    );
    return rows[0] || null;
  },

  async delete(id) {
    const { rowCount } = await pool.query('DELETE FROM cases WHERE id = $1', [id]);
    return rowCount > 0;
  },
};

module.exports = Case;
