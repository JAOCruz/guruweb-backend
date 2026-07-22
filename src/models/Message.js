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

  // Find the phone we previously used for a given wa_jid (used when a contact
  // sends messages from a privacy @lid JID so we keep one conversation thread).
  async findPhoneByWaJid(waJid) {
    const { rows } = await pool.query(
      `SELECT phone FROM messages WHERE wa_jid = $1 AND phone IS NOT NULL ORDER BY created_at DESC LIMIT 1`,
      [waJid]
    );
    return rows[0]?.phone || null;
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
  async findRecentByPhone(phone, limit = 20) {
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

  // Append media analysis / transcription to an already-saved message's content.
  // Keeps the bot's conversation context aware of what each image/audio contained
  // and lets employees read the extracted text in the dashboard. Uses the existing
  // `content` column — no schema migration required.
  async appendMediaAnalysis(waMessageId, analysisText) {
    if (!waMessageId || !analysisText) return null;
    const { rows } = await pool.query(
      `UPDATE messages SET content = content || E'\n' || $1 WHERE wa_message_id = $2 RETURNING id`,
      [analysisText, waMessageId]
    );
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

  // Get all conversations grouped by phone, with latest message and client info.
  // Registered clients WITHOUT messages also appear (admin sees all, employees see
  // assigned). Implemented as a UNION ALL (messages side + clients-without-messages
  // side) because PostgreSQL rejects FULL OUTER JOIN with an OR join condition
  // ("FULL JOIN is only supported with merge-joinable or hash-joinable join conditions").
  // If userId provided, only returns conversations from clients OR cases assigned to that user.
  async getConversations(filter = 'all', userId = null) {
    const uid = userId !== null ? parseInt(userId) : null;

    // Conditions for the messages side
    const msgConditions = [];
    if (filter === 'clients') {
      msgConditions.push('(m.client_id IS NOT NULL OR c.id IS NOT NULL)');
    } else if (filter === 'non_clients') {
      msgConditions.push('m.client_id IS NULL AND c.id IS NULL AND m.phone IS NOT NULL');
    }
    // Employee (digitador/auxiliar): only see assigned clients' or assigned cases' conversations.
    if (uid !== null) {
      if (filter === 'non_clients') {
        msgConditions.push('1=0'); // employees never see unregistered chats
      } else {
        msgConditions.push(`(
          c.assigned_to = ${uid}
          OR m.case_id IN (SELECT id FROM cases WHERE user_id = ${uid})
        )`);
      }
    }
    const msgWhere = msgConditions.length > 0 ? 'WHERE ' + msgConditions.join(' AND ') : '';

    // Conditions for the clients-without-messages side
    const cliConditions = ['NOT EXISTS (SELECT 1 FROM messages m2 WHERE m2.phone = c.phone OR m2.client_id = c.id)'];
    if (filter === 'non_clients') {
      cliConditions.push('1=0'); // a registered client is never a "non-client"
    }
    if (uid !== null) {
      cliConditions.push(`c.assigned_to = ${uid}`);
    }
    const cliWhere = 'WHERE ' + cliConditions.join(' AND ');

    const { rows } = await pool.query(`
      SELECT phone, client_id, client_name, client_assigned_to, profile_pic_url, last_message_at, message_count
      FROM (
        SELECT
          COALESCE(m.phone, c.phone) AS phone,
          MAX(COALESCE(m.client_id, c.id)) AS client_id,
          MAX(c.name) AS client_name,
          MAX(c.assigned_to) AS client_assigned_to,
          MAX(c.profile_pic_url) AS profile_pic_url,
          MAX(m.created_at) AS last_message_at,
          COUNT(m.id) AS message_count
        FROM messages m
        LEFT JOIN clients c ON c.id = m.client_id OR c.phone = m.phone
        ${msgWhere}
        GROUP BY COALESCE(m.phone, c.phone)

        UNION ALL

        SELECT
          c.phone, c.id, c.name, c.assigned_to, c.profile_pic_url, NULL, 0
        FROM clients c
        ${cliWhere}
      ) combined
      WHERE phone IS NOT NULL
      ORDER BY last_message_at DESC NULLS LAST
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
        MAX(COALESCE(m.client_id, c.id)) AS client_id,
        MAX(c.name) AS client_name,
        MAX(c.assigned_to) AS client_assigned_to,
        MAX(c.profile_pic_url) AS profile_pic_url,
        MAX(m.created_at) AS last_message_at,
        COUNT(*) AS message_count
      FROM messages m
      LEFT JOIN clients c ON c.id = m.client_id OR c.phone = m.phone
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
