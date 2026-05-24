const pool = require('../db/pool');

const ClientDetail = {
  async getFullClientData(clientId) {
    const client = await pool.query(
      'SELECT * FROM clients WHERE id = $1',
      [clientId]
    );
    if (!client.rows.length) return null;

    const clientData = client.rows[0];

    // Fetch services
    const services = await pool.query(
      `SELECT s.*, sc.abbreviation, sc.color, sc.category_type
       FROM client_services cs
       JOIN services s ON cs.service_id = s.id
       JOIN service_categories sc ON s.category_id = sc.id
       WHERE cs.client_id = $1 AND cs.status IN ('active', 'completed')
       ORDER BY cs.started_at DESC`,
      [clientId]
    );

    // Fetch cases with tags
    const casesCheck = await pool.query(
      `SELECT c.* FROM cases c WHERE c.client_id = $1 ORDER BY c.created_at DESC`,
      [clientId]
    );

    const cases = [];
    for (const caseRow of casesCheck.rows) {
      const caseTags = await pool.query(
        'SELECT tag_type, tag_value FROM case_tags WHERE case_id = $1',
        [caseRow.id]
      );
      cases.push({
        ...caseRow,
        tags: caseTags.rows,
      });
    }

    // Fetch messages
    const messages = await pool.query(
      `SELECT * FROM messages
       WHERE client_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [clientId]
    );

    // Fetch documents
    const documents = await pool.query(
      `SELECT * FROM document_requests
       WHERE client_id = $1
       ORDER BY created_at DESC`,
      [clientId]
    );

    // Fetch appointments
    const appointments = await pool.query(
      `SELECT * FROM appointments
       WHERE client_id = $1
       ORDER BY date DESC`,
      [clientId]
    );

    return {
      client: clientData,
      services: services.rows,
      cases: cases,
      messages: messages.rows,
      documents: documents.rows,
      appointments: appointments.rows,
      stats: {
        totalServices: services.rows.length,
        totalCases: cases.length,
        totalMessages: messages.rows.length,
        totalDocuments: documents.rows.length,
      }
    };
  },

  async getCasesByType(clientId) {
    const cases = await pool.query(
      `SELECT c.case_type, COUNT(*) as count
       FROM cases c
       WHERE c.client_id = $1
       GROUP BY c.case_type
       ORDER BY count DESC`,
      [clientId]
    );
    return cases.rows;
  }
};

module.exports = ClientDetail;
