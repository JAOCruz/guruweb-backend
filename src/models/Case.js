const pool = require('../db/pool');

const Case = {
  async create({
    caseNumber,
    title,
    description,
    caseType,
    caseSubtype,
    clientId,
    userId,
    court,
    institution,
    serviceId,
    expectedCompletionDate,
    nextHearing,
    source = 'whatsapp',
    status = 'new',
  }) {
    const { rows } = await pool.query(
      `INSERT INTO cases (
         case_number, title, description, case_type, case_subtype,
         client_id, user_id, court, institution, service_id,
         expected_completion_date, next_hearing, source, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        caseNumber,
        title,
        description || null,
        caseType || null,
        caseSubtype || null,
        clientId,
        userId,
        court || null,
        institution || null,
        serviceId || null,
        expectedCompletionDate || null,
        nextHearing || null,
        source,
        status,
      ]
    );
    return rows[0];
  },

  async findAll({ status, clientId, caseType, caseSubtype, userId, institution, serviceId } = {}) {
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
    if (caseSubtype) {
      params.push(caseSubtype);
      query += ` AND c.case_subtype = $${params.length}`;
    }
    if (userId) {
      params.push(userId);
      query += ` AND c.user_id = $${params.length}`;
    }
    if (institution) {
      params.push(institution);
      query += ` AND c.institution = $${params.length}`;
    }
    if (serviceId) {
      params.push(serviceId);
      query += ` AND c.service_id = $${params.length}`;
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

  async findByClientAndType(clientId, caseType, { excludeStatuses = [] } = {}) {
    let query = 'SELECT * FROM cases WHERE client_id = $1 AND case_type = $2';
    const params = [clientId, caseType];
    if (excludeStatuses.length > 0) {
      query += ` AND status NOT IN (${excludeStatuses.map((_, i) => `$${i + 3}`).join(', ')})`;
      params.push(...excludeStatuses);
    }
    query += ' ORDER BY created_at DESC LIMIT 1';
    const { rows } = await pool.query(query, params);
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

  // ── Status history ─────────────────────────────────────────────────────────

  async addStatusHistory({ caseId, status, changedByUserId, notes }) {
    const { rows } = await pool.query(
      `INSERT INTO case_status_history (case_id, status, changed_by_user_id, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [caseId, status, changedByUserId || null, notes || null]
    );
    return rows[0];
  },

  async getStatusHistory(caseId) {
    const { rows } = await pool.query(
      `SELECT h.*, u.username AS changed_by_username
       FROM case_status_history h
       LEFT JOIN users u ON u.id = h.changed_by_user_id
       WHERE h.case_id = $1
       ORDER BY h.created_at DESC`,
      [caseId]
    );
    return rows;
  },

  // ── Reminders ──────────────────────────────────────────────────────────────

  async scheduleReminder({ caseId, reminderType, scheduledAt }) {
    const { rows } = await pool.query(
      `INSERT INTO case_reminders (case_id, reminder_type, scheduled_at)
       VALUES ($1, $2, $3) RETURNING *`,
      [caseId, reminderType, scheduledAt]
    );
    return rows[0];
  },

  async getPendingReminders(before = new Date()) {
    const { rows } = await pool.query(
      `SELECT r.*, c.case_number, c.title, c.client_id, c.user_id,
              cl.name AS client_name, cl.phone AS client_phone,
              u.username AS assigned_username
       FROM case_reminders r
       JOIN cases c ON c.id = r.case_id
       LEFT JOIN clients cl ON cl.id = c.client_id
       LEFT JOIN users u ON u.id = c.user_id
       WHERE r.sent_at IS NULL AND r.scheduled_at <= $1
       ORDER BY r.scheduled_at ASC`,
      [before]
    );
    return rows;
  },

  async markReminderSent(reminderId, sentAt = new Date()) {
    const { rows } = await pool.query(
      `UPDATE case_reminders
       SET sent_at = $1
       WHERE id = $2
       RETURNING *`,
      [sentAt, reminderId]
    );
    return rows[0] || null;
  },
};

module.exports = Case;
