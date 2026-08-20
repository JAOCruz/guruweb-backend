const pool = require('../db/pool');

const Invoice = {
  async create({ docNumber, type = 'COTIZACIÓN', clientId, caseId = null, clientName, clientPhone, items, notes, subtotal, itbis, total, createdBy, source = 'whatsapp' }) {
    const { rows } = await pool.query(
      `INSERT INTO invoices
         (doc_number, type, status, client_id, case_id, client_name, client_phone, items, notes, subtotal, itbis, total, created_by, source)
       VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING *`,
      [docNumber, type, clientId || null, caseId || null, clientName, clientPhone || null,
       JSON.stringify(items), notes || null, subtotal, itbis, total, createdBy, source]
    );
    return rows[0];
  },

  async findAll() {
    const { rows } = await pool.query(`
      SELECT i.*,
             cb.name AS created_by_name,
             ab.name AS approved_by_name,
             rb.name AS rejected_by_name
      FROM invoices i
      LEFT JOIN users cb ON cb.id = i.created_by
      LEFT JOIN users ab ON ab.id = i.approved_by
      LEFT JOIN users rb ON rb.id = i.rejected_by
      ORDER BY i.created_at DESC
    `);
    return rows;
  },

  async findByCreator(userId) {
    const { rows } = await pool.query(`
      SELECT i.*,
             cb.name AS created_by_name,
             ab.name AS approved_by_name,
             rb.name AS rejected_by_name
      FROM invoices i
      LEFT JOIN users cb ON cb.id = i.created_by
      LEFT JOIN users ab ON ab.id = i.approved_by
      LEFT JOIN users rb ON rb.id = i.rejected_by
      WHERE i.created_by = $1
      ORDER BY i.created_at DESC
    `, [userId]);
    return rows;
  },

  async findByAssignedTo(userId) {
    const { rows } = await pool.query(`
      SELECT i.*,
             cb.name AS created_by_name,
             ab.name AS approved_by_name,
             rb.name AS rejected_by_name
      FROM invoices i
      LEFT JOIN users cb ON cb.id = i.created_by
      LEFT JOIN users ab ON ab.id = i.approved_by
      LEFT JOIN users rb ON rb.id = i.rejected_by
      WHERE i.client_id IN (SELECT id FROM clients WHERE assigned_to = $1)
         OR i.created_by = $1
      ORDER BY i.created_at DESC
    `, [userId]);
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query(`
      SELECT i.*,
             cb.name AS created_by_name,
             ab.name AS approved_by_name,
             rb.name AS rejected_by_name
      FROM invoices i
      LEFT JOIN users cb ON cb.id = i.created_by
      LEFT JOIN users ab ON ab.id = i.approved_by
      LEFT JOIN users rb ON rb.id = i.rejected_by
      WHERE i.id = $1
    `, [id]);
    return rows[0] || null;
  },

  async approve(id, adminId) {
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
       WHERE id=$2 AND status IN ('draft', 'pending_approval')
       RETURNING *`,
      [adminId, id]
    );
    return rows[0] || null;
  },

  async requestApproval(id) {
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status='pending_approval', updated_at=NOW()
       WHERE id=$1 AND status='draft'
       RETURNING *`,
      [id]
    );
    return rows[0] || null;
  },

  async countPendingApproval() {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS count FROM invoices WHERE status='pending_approval'`
    );
    return rows[0]?.count || 0;
  },

  async markSent(id, pdfPath, pdfS3Key = null, storageType = 'local') {
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status='sent', pdf_path=$1, pdf_s3_key=$2, pdf_storage_type=$3, sent_at=NOW(), updated_at=NOW()
       WHERE id=$4
       RETURNING *`,
      [pdfPath || null, pdfS3Key, storageType, id]
    );
    return rows[0] || null;
  },

  async confirmPayment(id, { paidBy, paymentMethod, paymentReference }) {
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status='paid', paid_by=$1, paid_at=NOW(), payment_method=$2, payment_reference=$3, updated_at=NOW()
       WHERE id=$4 AND status IN ('approved', 'sent')
       RETURNING *`,
      [paidBy, paymentMethod || null, paymentReference || null, id]
    );
    return rows[0] || null;
  },

  async reject(id, adminId, reason = null) {
    const { rows } = await pool.query(
      `UPDATE invoices
       SET status='rejected', rejected_by=$1, rejected_at=NOW(), updated_at=NOW(), notes = COALESCE(notes, '') || E'\n\n[RECHAZADO] ' || $2
       WHERE id=$3 AND status IN ('draft', 'pending_approval')
       RETURNING *`,
      [adminId, reason || 'Rechazado por administrador', id]
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
