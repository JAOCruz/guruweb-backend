const express = require('express');
const { authenticate } = require('../middleware/auth');
const pool = require('../db/pool');

const router = express.Router();
router.use(authenticate);

// Get cases by type with client info and tags
router.get('/', async (req, res) => {
  try {
    const { case_type, status, client_id } = req.query;

    let query = `
      SELECT c.*,
             cl.name as client_name,
             cl.phone as client_phone,
             COALESCE(json_agg(json_build_object('tag_type', ct.tag_type, 'tag_value', ct.tag_value))
              FILTER (WHERE ct.id IS NOT NULL), '[]'::json) as tags
      FROM cases c
      LEFT JOIN clients cl ON c.client_id = cl.id
      LEFT JOIN case_tags ct ON c.id = ct.case_id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (case_type) {
      query += ` AND c.case_type = $${paramIndex}`;
      params.push(case_type);
      paramIndex++;
    }

    if (status) {
      query += ` AND c.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (client_id) {
      query += ` AND c.client_id = $${paramIndex}`;
      params.push(client_id);
      paramIndex++;
    }

    query += ` GROUP BY c.id, cl.id ORDER BY c.created_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error('Get cases error:', err);
    res.status(500).json({ error: 'Failed to get cases' });
  }
});

// Get single case
router.get('/:id', async (req, res) => {
  try {
    const caseData = await pool.query(
      `SELECT c.*,
              cl.name as client_name,
              cl.phone as client_phone,
              COALESCE(json_agg(json_build_object('tag_type', ct.tag_type, 'tag_value', ct.tag_value))
               FILTER (WHERE ct.id IS NOT NULL), '[]'::json) as tags
       FROM cases c
       LEFT JOIN clients cl ON c.client_id = cl.id
       LEFT JOIN case_tags ct ON c.id = ct.case_id
       WHERE c.id = $1
       GROUP BY c.id, cl.id`,
      [req.params.id]
    );

    if (!caseData.rows.length) {
      return res.status(404).json({ error: 'Case not found' });
    }

    res.json(caseData.rows[0]);
  } catch (err) {
    console.error('Get case error:', err);
    res.status(500).json({ error: 'Failed to get case' });
  }
});

// Create case
router.post('/', async (req, res) => {
  try {
    const { case_number, title, description, case_type, client_id, user_id, court, next_hearing } = req.body;

    if (!case_number || !title || !client_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const { rows } = await pool.query(
      `INSERT INTO cases (case_number, title, description, case_type, client_id, user_id, court, next_hearing)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [case_number, title, description || null, case_type || null, client_id, user_id || null, court || null, next_hearing || null]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Create case error:', err);
    res.status(500).json({ error: 'Failed to create case' });
  }
});

// Update case
router.put('/:id', async (req, res) => {
  try {
    const { title, description, status, case_type, court, next_hearing } = req.body;
    const updates = {};
    if (title) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (status) updates.status = status;
    if (case_type !== undefined) updates.case_type = case_type;
    if (court !== undefined) updates.court = court;
    if (next_hearing !== undefined) updates.next_hearing = next_hearing;

    const keys = Object.keys(updates);
    if (!keys.length) return res.status(400).json({ error: 'No fields to update' });

    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const values = Object.values(updates);

    const { rows } = await pool.query(
      `UPDATE cases SET ${sets}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, req.params.id]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Case not found' });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error('Update case error:', err);
    res.status(500).json({ error: 'Failed to update case' });
  }
});

// Add tag to case
router.post('/:id/tags', async (req, res) => {
  try {
    const { tag_type, tag_value } = req.body;
    if (!tag_type || !tag_value) {
      return res.status(400).json({ error: 'Missing tag_type or tag_value' });
    }

    const { rows } = await pool.query(
      `INSERT INTO case_tags (case_id, tag_type, tag_value)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [req.params.id, tag_type, tag_value]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('Add case tag error:', err);
    res.status(500).json({ error: 'Failed to add tag' });
  }
});

module.exports = router;
