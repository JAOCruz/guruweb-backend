const pool = require('../db/pool');

const Message = {
  async create({ waMessageId, phone, clientId, caseId, direction, content, mediaUrl, status = 'sent', waJid = null }) {
    const { rows } = await pool.query(
      `INSERT INTO messages (wa_message_id, phone, client_id, case_id, direction, content, media_url, status, wa_jid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [waMessageId || null, phone || null, clientId, caseId || null, direction, content, mediaUrl || null, status, waJid]
    );
    return rows[0];
  },

  // Get the last known real JID for a phone (handles @lid accounts)
  async getLastJid(phone) {
    const { rows } = await pool.query(
      `SELECT wa_jid FROM messages WHERE phone = $1 AND wa_jid IS NOT NULL AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1`,
      [phone]
    );
    return rows[0]?.wa_jid || null;
  },

  async findByClient(clientId, { limit = 50, offset = 0 } = {}) {
    const { rows } = await pool.query(
      'SELECT * FROM messages WHERE client_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [clientId, limit, offset]
    );
    return rows;
  },

  async findByPhone(phone, { limit = 100, offset = 0 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM messages
       WHERE phone = $1
          OR (phone IS NULL AND client_id IN (SELECT id FROM clients WHERE phone = $1))
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [phone, limit, offset]
    );
    return rows;
  },

  // Get recent messages for a phone in chronological order (for LLM context)
  async findRecentByPhone(phone, limit = 8) {
    const { rows } = await pool.query(
      `SELECT direction, content FROM messages
       WHERE phone = $1
       ORDER BY created_at DESC LIMIT $2`,
      [phone, limit]
    );
    return rows.reverse();
  },

  async findByCase(caseId, { limit = 50, offset = 0 } = {}) {
    const { rows } = await pool.query(
      'SELECT * FROM messages WHERE case_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3',
      [caseId, limit, offset]
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async updateStatus(id, status) {
    const { rows } = await pool.query(
      'UPDATE messages SET status = $1 WHERE id = $2 RETURNING *',
      [status, id]
    );
    return rows[0] || null;
  },

  async update(id, fields) {
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE messages SET ${sets} WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, id]
    );
    return rows[0] || null;
  },

  async linkToClient(messageId, clientId) {
    const { rows } = await pool.query(
      'UPDATE messages SET client_id = $1 WHERE id = $2 RETURNING *',
      [clientId, messageId]
    );
    return rows[0] || null;
  },

  // Get all conversations grouped by phone, with latest message and client info
  // Uses COALESCE to fall back to client.phone for old messages missing the phone column
  // If userId provided, only returns conversations from clients assigned to that user
  async getConversations(filter = 'all', userId = null) {
    const conditions = [];
    if (filter === 'clients') {
      conditions.push('m.client_id IS NOT NULL');
    } else if (filter === 'non_clients') {
      conditions.push('m.client_id IS NULL AND m.phone IS NOT NULL');
    }

    // Digitador: only see assigned clients' conversations (non-client phones hidden)
    if (userId !== null) {
      conditions.push(`(m.client_id IS NULL OR c.assigned_to = ${parseInt(userId)})`);
      // For digitadores, only show 'clients' filter effectively (no unregistered chats)
      // Remove the non_clients option by requiring client_id
      if (filter !== 'non_clients') {
        // Replace conditions to force assigned filter
        conditions.length = 0;
        conditions.push(`m.client_id IS NOT NULL AND c.assigned_to = ${parseInt(userId)}`);
      }
    }

    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await pool.query(`
      SELECT
        COALESCE(m.phone, c.phone) AS phone,
        MAX(m.client_id) AS client_id,
        MAX(c.name) AS client_name,
        MAX(m.created_at) AS last_message_at,
        COUNT(*) AS message_count
      FROM messages m
      LEFT JOIN clients c ON c.id = m.client_id
      ${whereClause}
      GROUP BY COALESCE(m.phone, c.phone)
      HAVING COALESCE(m.phone, c.phone) IS NOT NULL
      ORDER BY MAX(m.created_at) DESC
    `);

    // Fetch last message for each conversation
    for (const conv of rows) {
      const { rows: last } = await pool.query(`
        SELECT content, direction FROM messages
        WHERE phone = $1 OR (phone IS NULL AND client_id IN (SELECT id FROM clients WHERE phone = $1))
        ORDER BY created_at DESC LIMIT 1
      `, [conv.phone]);
      conv.last_message = last[0]?.content || '';
      conv.last_direction = last[0]?.direction || '';
    }

    return rows;
  },

  async searchByContent(searchTerm) {
    const term = `%${searchTerm}%`;
    const { rows } = await pool.query(`
      SELECT
        COALESCE(m.phone, c.phone) AS phone,
        MAX(m.client_id) AS client_id,
        MAX(c.name) AS client_name,
        MAX(m.created_at) AS last_message_at,
        COUNT(*) AS message_count
      FROM messages m
      LEFT JOIN clients c ON c.id = m.client_id
      WHERE LOWER(m.content) LIKE LOWER($1)
      GROUP BY COALESCE(m.phone, c.phone)
      ORDER BY MAX(m.created_at) DESC
      LIMIT 50
    `, [term]);

    for (const conv of rows) {
      const { rows: last } = await pool.query(`
        SELECT content, direction FROM messages
        WHERE phone = $1 OR (phone IS NULL AND client_id IN (SELECT id FROM clients WHERE phone = $1))
        ORDER BY created_at DESC LIMIT 1
      `, [conv.phone]);
      conv.last_message = last[0]?.content || '';
      conv.last_direction = last[0]?.direction || '';

      // Get first matching message ID for this conversation
      const { rows: match } = await pool.query(`
        SELECT id FROM messages
        WHERE (phone = $1 OR (phone IS NULL AND client_id IN (SELECT id FROM clients WHERE phone = $1)))
          AND LOWER(content) LIKE LOWER($2)
        ORDER BY created_at ASC LIMIT 1
      `, [conv.phone, term]);
      conv.firstMatchId = match[0]?.id || null;
    }

    return rows;
  },
};

module.exports = Message;
