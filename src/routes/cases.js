const express = require('express');
const Case = require('../models/Case');
const Client = require('../models/Client');
const Notification = require('../models/Notification');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

function isEmployee(role) {
  return role !== 'admin';
}
const config = require('../config');

const router = express.Router();

// Rule-based complaint detection (no AI, no quota issues)
function detectComplaint(text) {
  const lower = text.toLowerCase();
  let complaintType = null;
  let score = 0;

  // Strong complaint signals (high confidence)
  if (lower.includes('dinero de vuelta') || lower.includes('devuelva') || lower.includes('reembolso') || lower.includes('quiero mi dinero')) {
    score += 90;
    complaintType = 'producto_defectuoso';
  }

  // Defect/damage keywords
  const defectKeywords = ['defectuoso', 'roto', 'dañado', 'no funciona', 'no sirvió', 'no sirve', 'no funciono', 'broken', 'dañada', 'no prendió'];
  if (defectKeywords.some(k => lower.includes(k))) {
    complaintType = 'producto_defectuoso';
    score += 85;
  }

  // Price complaint keywords
  const priceKeywords = ['caro', 'muy caro', 'precio alto', 'precio muy alto', 'cobró más', 'cobro equivocado', 'precio incorrecto', 'precio es injusto'];
  if (priceKeywords.some(k => lower.includes(k))) {
    complaintType = 'precios_altos';
    score += 80;
  }

  // Service issue keywords
  const serviceKeywords = ['mal servicio', 'servicio malo', 'no me sirvió', 'decepción', 'queja', 'protesta', 'inconformidad'];
  if (serviceKeywords.some(k => lower.includes(k))) {
    complaintType = complaintType || 'servicio_erroneo';
    score += 75;
  }

  // Error/wrong item keywords
  const errorKeywords = ['error', 'equivocado', 'incorrecto', 'mal', 'confusión', 'confundieron', 'mandaron mal', 'equivocación'];
  if (errorKeywords.some(k => lower.includes(k))) {
    complaintType = complaintType || 'info_erronea';
    score += 70;
  }

  // Determine case type based on product mentions
  let caseType = 'reclamaciones'; // default

  // Tienda Física products from PDF
  const tiendaFisicaProducts = [
    'papel', 'carpeta', 'bolígrafo', 'lápiz', 'tijera', 'folder', 'sacapunta', 'sacapuntas',
    'liquid paper', 'sobre', 'cd', 'adhesivo', 'satinado', 'marcador', 'resaltador',
    'fotocopia', 'impresión', 'brochure', 'foto 2x2', 'lamina', 'cartonite'
  ];

  if (tiendaFisicaProducts.some(k => lower.includes(k))) {
    caseType = 'tienda_fisica';
  }

  return {
    is_complaint: score >= 50,
    case_type: score >= 50 ? caseType : null,
    complaint_tag: score >= 50 ? complaintType : null,
    confidence: Math.min(100, score),
  };
}

// Internal endpoint for complaint detection (no auth required)
router.post('/detect-and-create', authenticate, async (req, res) => {
  try {
    const { message_text, phone, client_id, message_timestamp } = req.body;
    if (!message_text || !phone) {
      return res.status(400).json({ error: 'message_text and phone are required' });
    }

    // Rule-based detection (no AI)
    const analysis = detectComplaint(message_text);

    if (!analysis.is_complaint || !analysis.case_type) {
      return res.json({ is_complaint: false, case_type: null });
    }

    // Get or find client
    let client = null;
    if (client_id) {
      client = await Client.findById(client_id);
    } else {
      client = await Client.findByPhone(phone);
    }
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Generate unique case number
    const timestamp = Date.now();
    const caseNumber = `REC-${timestamp}`;

    // Create case
    const caseRecord = await Case.create({
      caseNumber,
      title: `Reclamación reportada vía WhatsApp`,
      description: message_text,
      caseType: analysis.case_type,
      clientId: client.id,
      userId: null,
    });

    // Add complaint tag
    if (analysis.complaint_tag) {
      await pool.query(
        'INSERT INTO case_tags (case_id, tag_type, tag_value) VALUES ($1, $2, $3)',
        [caseRecord.id, 'complaint_type', analysis.complaint_tag]
      );
    }

    // Add message reference (source of complaint)
    if (message_timestamp) {
      await pool.query(
        'INSERT INTO case_tags (case_id, tag_type, tag_value) VALUES ($1, $2, $3)',
        [caseRecord.id, 'source_message_timestamp', message_timestamp]
      );
      await pool.query(
        'INSERT INTO case_tags (case_id, tag_type, tag_value) VALUES ($1, $2, $3)',
        [caseRecord.id, 'source_phone', phone]
      );
    }

    // Notify admins and the assigned digitador of any previous case for this client
    try {
      const { rows: admins } = await pool.query("SELECT id FROM users WHERE role = 'admin'");
      const { rows: assignedCases } = await pool.query(
        `SELECT DISTINCT user_id FROM cases
         WHERE client_id = $1 AND user_id IS NOT NULL
         ORDER BY updated_at DESC LIMIT 1`,
        [client.id]
      );

      const notifiedUserIds = new Set();
      for (const admin of admins) {
        await Notification.create({
          userId: admin.id,
          type: 'complaint',
          title: 'Nueva reclamación',
          message: `Reclamación de ${client.name || phone}: ${analysis.case_type}`,
          link: `/cases/${caseRecord.id}`,
          metadata: { case_id: caseRecord.id, client_id: client.id, phone },
        });
        notifiedUserIds.add(admin.id);
      }

      for (const assigned of assignedCases) {
        if (!notifiedUserIds.has(assigned.user_id)) {
          await Notification.create({
            userId: assigned.user_id,
            type: 'complaint',
            title: 'Reclamación de un cliente asignado',
            message: `El cliente ${client.name || phone} ha generado una reclamación: ${analysis.case_type}`,
            link: `/cases/${caseRecord.id}`,
            metadata: { case_id: caseRecord.id, client_id: client.id, phone },
          });
        }
      }
    } catch (notifyErr) {
      console.error('[Cases] Failed to create complaint notifications:', notifyErr.message);
    }

    console.log(`[Cases] Auto-created complaint case #${caseRecord.id} for ${phone}: ${analysis.case_type} (${analysis.complaint_tag})`);

    res.json({
      is_complaint: true,
      case_type: analysis.case_type,
      case_id: caseRecord.id,
      case_number: caseRecord.case_number,
      complaint_tag: analysis.complaint_tag,
      confidence: analysis.confidence,
    });
  } catch (err) {
    console.error('Complaint detection error:', err);
    res.status(500).json({ error: 'Complaint detection failed' });
  }
});

router.use(authenticate);

router.get('/', async (req, res) => {
  try {
    const { status, client_id, case_type } = req.query;
    const filters = { status, clientId: client_id, caseType: case_type };
    // Employees only see cases assigned to them
    if (isEmployee(req.user.role)) {
      filters.userId = req.user.id;
    }
    const cases = await Case.findAll(filters);
    res.json({ cases });
  } catch (err) {
    console.error('List cases error:', err);
    res.status(500).json({ error: 'Failed to list cases' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const caseRecord = await Case.findById(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    if (isEmployee(req.user.role) && caseRecord.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json({ case: caseRecord });
  } catch (err) {
    console.error('Get case error:', err);
    res.status(500).json({ error: 'Failed to get case' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { case_number, title, description, case_type, client_id, court, next_hearing } = req.body;
    if (!case_number || !title || !client_id) {
      return res.status(400).json({ error: 'case_number, title, and client_id are required' });
    }
    const caseRecord = await Case.create({
      caseNumber: case_number,
      title,
      description,
      caseType: case_type,
      clientId: client_id,
      userId: req.user.id,
      court,
      nextHearing: next_hearing,
    });
    res.status(201).json({ case: caseRecord });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Case number already exists' });
    }
    console.error('Create case error:', err);
    res.status(500).json({ error: 'Failed to create case' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { title, description, status, case_type, court, next_hearing } = req.body;
    const fields = {};
    if (title !== undefined) fields.title = title;
    if (description !== undefined) fields.description = description;
    if (status !== undefined) fields.status = status;
    if (case_type !== undefined) fields.case_type = case_type;
    if (court !== undefined) fields.court = court;
    if (next_hearing !== undefined) fields.next_hearing = next_hearing;

    const caseRecord = await Case.update(req.params.id, fields);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    res.json({ case: caseRecord });
  } catch (err) {
    console.error('Update case error:', err);
    res.status(500).json({ error: 'Failed to update case' });
  }
});

// Mark case as resolved (admin only)
router.post('/:id/resolve', async (req, res) => {
  try {
    const caseRecord = await Case.update(req.params.id, { status: 'resolved' });
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    console.log(`[Cases] Case #${req.params.id} marked as resolved by ${req.user.username}`);
    res.json({ case: caseRecord, message: 'Case marked as resolved' });
  } catch (err) {
    console.error('Resolve case error:', err);
    res.status(500).json({ error: 'Failed to resolve case' });
  }
});

// Reopen a resolved case
router.post('/:id/reopen', async (req, res) => {
  try {
    const caseRecord = await Case.update(req.params.id, { status: 'open' });
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    console.log(`[Cases] Case #${req.params.id} reopened by ${req.user.username}`);
    res.json({ case: caseRecord, message: 'Case reopened' });
  } catch (err) {
    console.error('Reopen case error:', err);
    res.status(500).json({ error: 'Failed to reopen case' });
  }
});

// Assign case to a user (admin only)
router.post('/:id/assign', requireRole('admin'), async (req, res) => {
  try {
    const { user_id, notes } = req.body;
    if (!user_id) {
      return res.status(400).json({ error: 'user_id is required' });
    }
    const caseRecord = await Case.findById(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });

    const previousUserId = caseRecord.user_id;
    const updated = await Case.update(req.params.id, { user_id, status: 'in_progress' });

    await pool.query(
      `INSERT INTO case_assignment_history (case_id, from_user_id, to_user_id, assigned_by, notes)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, previousUserId, user_id, req.user.id, notes || null]
    );

    console.log(`[Cases] Case #${req.params.id} assigned to user ${user_id} by ${req.user.username}`);
    res.json({ case: updated, message: 'Case assigned' });
  } catch (err) {
    console.error('Assign case error:', err);
    res.status(500).json({ error: 'Failed to assign case' });
  }
});

// Close case (admin only)
// reason: 'paid', 'cancelled', 'resolved', 'other'
router.post('/:id/close', requireRole('admin'), async (req, res) => {
  try {
    const { reason, notes } = req.body;
    const caseRecord = await Case.findById(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });

    const newStatus = reason === 'paid' ? 'paid' : 'closed';
    const updated = await Case.update(req.params.id, {
      status: newStatus,
      description: caseRecord.description
        ? `${caseRecord.description}\n\n[CERRADO - ${reason || 'other'}${notes ? ': ' + notes : ''}]`
        : `[CERRADO - ${reason || 'other'}${notes ? ': ' + notes : ''}]`,
    });

    console.log(`[Cases] Case #${req.params.id} closed (${reason}) by ${req.user.username}`);
    res.json({ case: updated, message: 'Case closed' });
  } catch (err) {
    console.error('Close case error:', err);
    res.status(500).json({ error: 'Failed to close case' });
  }
});

// Get assignment history for a case
router.get('/:id/assignment-history', authenticate, async (req, res) => {
  try {
    const caseRecord = await Case.findById(req.params.id);
    if (!caseRecord) return res.status(404).json({ error: 'Case not found' });
    if (isEmployee(req.user.role) && caseRecord.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { rows } = await pool.query(
      `SELECT h.*,
              fu.username AS from_username,
              tu.username AS to_username,
              bu.username AS assigned_by_username
       FROM case_assignment_history h
       LEFT JOIN users fu ON fu.id = h.from_user_id
       LEFT JOIN users tu ON tu.id = h.to_user_id
       LEFT JOIN users bu ON bu.id = h.assigned_by
       WHERE h.case_id = $1
       ORDER BY h.assigned_at DESC`,
      [req.params.id]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error('Get case assignment history error:', err);
    res.status(500).json({ error: 'Failed to get assignment history' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Case.delete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Case not found' });
    res.json({ message: 'Case deleted' });
  } catch (err) {
    console.error('Delete case error:', err);
    res.status(500).json({ error: 'Failed to delete case' });
  }
});

module.exports = router;
