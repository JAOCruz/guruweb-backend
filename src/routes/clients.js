const express = require('express');
const Client = require('../models/Client');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

function isEmployee(role) {
  return role !== 'admin';
}

const router = express.Router();
router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    let clients;
    if (isEmployee(req.user.role)) {
      clients = await Client.findByAssignedTo(req.user.id);
    } else {
      clients = await Client.findAll();
    }
    res.json({ clients });
  } catch (err) {
    console.error('List clients error:', err);
    res.status(500).json({ error: 'Failed to list clients' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    // Employee can only access assigned clients
    if (isEmployee(req.user.role) && client.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ client });
  } catch (err) {
    console.error('Get client error:', err);
    res.status(500).json({ error: 'Failed to get client' });
  }
});

router.get('/:id/summary', async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const [cases, docs, msgs, appointments] = await Promise.all([
      pool.query('SELECT id, case_number, title, status, case_type, created_at FROM cases WHERE client_id = $1 ORDER BY created_at DESC', [client.id]),
      pool.query('SELECT COUNT(*) FROM document_requests WHERE client_id = $1', [client.id]),
      pool.query('SELECT COUNT(*) FROM messages WHERE client_id = $1', [client.id]),
      pool.query("SELECT id, date, time, type, status FROM appointments WHERE client_id = $1 AND date >= CURRENT_DATE ORDER BY date, time", [client.id]),
    ]);

    res.json({
      client,
      cases: cases.rows,
      documentCount: parseInt(docs.rows[0].count),
      messageCount: parseInt(msgs.rows[0].count),
      upcomingAppointments: appointments.rows,
    });
  } catch (err) {
    console.error('Client summary error:', err);
    res.status(500).json({ error: 'Failed to get client summary' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ error: 'name and phone are required' });
    }
    const client = await Client.create({ name, phone, email, address, notes, userId: req.user.id });
    res.status(201).json({ client });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Phone number already exists' });
    }
    console.error('Create client error:', err);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, phone, email, address, notes } = req.body;
    const fields = {};
    if (name !== undefined) fields.name = name;
    if (phone !== undefined) fields.phone = phone;
    if (email !== undefined) fields.email = email;
    if (address !== undefined) fields.address = address;
    if (notes !== undefined) fields.notes = notes;

    // Claim orphaned bot-created clients
    const existing = await Client.findById(req.params.id);
    if (existing && !existing.user_id) {
      fields.user_id = req.user.id;
    }

    const client = await Client.update(req.params.id, fields);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    // Sync name into case titles (format: "CaseType — ClientName")
    if (name && existing && existing.name !== name) {
      await pool.query(
        `UPDATE cases SET title = regexp_replace(title, ' — .*$', ' — ' || $1) WHERE client_id = $2 AND title LIKE '%—%'`,
        [name, req.params.id]
      ).catch(err => console.error('Sync case titles error:', err));
    }

    res.json({ client });
  } catch (err) {
    console.error('Update client error:', err);
    res.status(500).json({ error: 'Failed to update client' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Client.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Client not found' });
    res.json({ message: 'Client deleted' });
  } catch (err) {
    console.error('Delete client error:', err);
    res.status(500).json({ error: 'Failed to delete client' });
  }
});

// Admin-only: assign a client to a digitador/auxiliar
router.post('/:id/assign', requireRole('admin'), async (req, res) => {
  try {
    const { user_id } = req.body;
    if (user_id === undefined || user_id === null || user_id === '') {
      return res.status(400).json({ error: 'user_id is required' });
    }
    const targetUserId = parseInt(user_id, 10);
    if (Number.isNaN(targetUserId)) {
      return res.status(400).json({ error: 'user_id must be a number' });
    }

    // Verify target user exists and is not admin (admins don't need assignment)
    const { rows: userRows } = await pool.query(
      'SELECT id, role, username, name FROM users WHERE id = $1',
      [targetUserId]
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: 'Target user not found' });
    }

    const client = await Client.update(req.params.id, { assigned_to: targetUserId });
    if (!client) return res.status(404).json({ error: 'Client not found' });

    console.log(`[Clients] Client ${req.params.id} assigned to user ${targetUserId} (${userRows[0].username}) by ${req.user.username}`);
    res.json({ client, assigned_to_user: userRows[0] });
  } catch (err) {
    console.error('Assign client error:', err);
    res.status(500).json({ error: 'Failed to assign client' });
  }
});

// Get detailed client information
router.get('/:id/detail', async (req, res) => {
  try {
    const ClientDetail = require('../models/ClientDetail');
    const detail = await ClientDetail.getFullClientData(req.params.id);
    if (!detail) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.json(detail);
  } catch (err) {
    console.error('Get client detail error:', err);
    res.status(500).json({ error: 'Failed to get client detail' });
  }
});

// Get cases by type for a client
router.get('/:id/cases-summary', async (req, res) => {
  try {
    const ClientDetail = require('../models/ClientDetail');
    const summary = await ClientDetail.getCasesByType(req.params.id);
    res.json({ cases_by_type: summary });
  } catch (err) {
    console.error('Get cases summary error:', err);
    res.status(500).json({ error: 'Failed to get cases summary' });
  }
});

// Get media for a client
router.get('/:id/media', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM client_media WHERE client_id = $1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json({ media: rows });
  } catch (err) {
    console.error('Get client media error:', err);
    res.status(500).json({ error: 'Failed to get client media' });
  }
});

// Assign client to an employee (admin only)
router.put('/:id/assign', requireRole('admin'), async (req, res) => {
  try {
    const { user_id, notes } = req.body;
    const clientId = req.params.id;

    const client = await Client.findById(clientId);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const previousUserId = client.assigned_to;

    const updated = await Client.update(clientId, { assigned_to: user_id || null });

    await pool.query(
      `INSERT INTO client_assignment_history (client_id, from_user_id, to_user_id, assigned_by, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [clientId, previousUserId, user_id || null, req.user.id, notes || null]
    );

    console.log(`[Clients] Client #${clientId} assigned to user ${user_id} by ${req.user.username}`);
    res.json({ client: updated, message: 'Client assigned successfully' });
  } catch (err) {
    console.error('Assign client error:', err);
    res.status(500).json({ error: 'Failed to assign client' });
  }
});

module.exports = router;
