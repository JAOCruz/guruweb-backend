const pool = require('../db/pool');

const Invoice = {
  async create({ docNumber, type = 'COTIZACIÓN', clientId, clientName, clientPhone, items, notes, subtotal, itbis, total, createdBy }) {
    const { rows } = await pool.query(
      `INSERT INTO invoices
         (doc_number, type, status, client_id, client_name, client_phone, items, notes, subtotal, itbis, total, created_by)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [docNumber, type, clientId || null, clientName, clientPhone || null,
       JSON.stringify(items), notes || null, subtotal, itbis, total, createdBy]
    );
    return rows[0];
  },

  async findAll() {
    const { rows } = await pool.query(`
      SELECT i.*,
             cb.name AS created_by_name,
             ab.name AS approved_by_name
      FROM invoices i
      LEFT JOIN users cb ON cb.id = i.created_by
      LEFT JOIN users ab ON ab.id = i.approved_by
      ORDER BY i.created_at DESC
    `);
    return rows;
  },

  async findByCreator(userId) {
    const { rows } = await pool.query(`
      SELECT i.*,
             cb.name AS created_by_name,
             ab.name AS approved_by_name
      FROM invoices i
      LEFT JOIN users cb ON cb.id = i.created_by
      LEFT JOIN users ab ON ab.id = i.approved_by
      WHERE i.created_by = $1
      ORDER BY i.created_at DESC
    `, [userId]);
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query(`
      SELECT i.*,
             cb.name AS created_by_name,
             ab.name AS approved_by_name
      FROM invoices i
      LEFT JOIN users cb ON cb.id = i.created_by
      LEFT JOIN users ab ON ab.id = i.approved_by
      WHERE i.id = $1
    `, [id]);
    return rows[0] || null;
  },

  async approve(id, adminId) {
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND status='draft'
       RETURNING *`,
      [adminId, id]
    );
    return rows[0] || null;
  },

  async markSent(id, pdfPath) {
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status='sent', pdf_path=$1, sent_at=NOW(), updated_at=NOW()
       WHERE id=$2
       RETURNING *`,
      [pdfPath || null, id]
    );
    return rows[0] || null;
  },

  async update(id, fields) {
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE invoices SET ${sets}, updated_at=NOW() WHERE id=$${keys.length + 1} RETURNING *`,
      [...values, id]
    );
    return rows[0] || null;
  },

  async delete(id) {
    const { rowCount } = await pool.query('DELETE FROM invoices WHERE id=$1', [id]);
    return rowCount > 0;
  },
};

module.exports = Invoice;
