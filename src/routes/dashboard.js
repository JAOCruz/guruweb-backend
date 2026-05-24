const express = require('express');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');
const Appointment = require('../models/Appointment');
const DocumentRequest = require('../models/DocumentRequest');
const LEGAL_TOPICS = require('../knowledge/legalTopics');
const INSTITUTIONS = require('../knowledge/institutions');
const { SERVICE_CATEGORIES } = require('../knowledge/services');

const router = express.Router();
router.use(authenticate);

// ── Dashboard Stats ──
router.get('/stats', async (req, res) => {
  try {
    const [clients, cases, msgs, appts] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM clients'),
      pool.query("SELECT COUNT(*) FROM cases WHERE status NOT IN ('closed','archived')"),
      pool.query("SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE"),
      pool.query("SELECT COUNT(*) FROM appointments WHERE status = 'pendiente' AND date >= CURRENT_DATE"),
    ]);
    res.json({
      clientCount: parseInt(clients.rows[0].count),
      activeCases: parseInt(cases.rows[0].count),
      messagesToday: parseInt(msgs.rows[0].count),
      pendingAppointments: parseInt(appts.rows[0].count),
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// ── Recent Activity ──
router.get('/recent', async (req, res) => {
  try {
    const [msgs, cases] = await Promise.all([
      pool.query('SELECT * FROM messages ORDER BY created_at DESC LIMIT 15'),
      pool.query('SELECT * FROM cases ORDER BY created_at DESC LIMIT 10'),
    ]);
    res.json({ recentMessages: msgs.rows, recentCases: cases.rows });
  } catch (err) {
    console.error('Dashboard recent error:', err);
    res.status(500).json({ error: 'Failed to load recent activity' });
  }
});

// ── Appointments ──
router.get('/appointments', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.*, c.name as client_name FROM appointments a
       LEFT JOIN clients c ON a.client_id = c.id
       ORDER BY a.date DESC, a.time`
    );
    res.json({ appointments: rows });
  } catch (err) {
    console.error('Appointments list error:', err);
    res.status(500).json({ error: 'Failed to load appointments' });
  }
});

router.put('/appointments/:id', async (req, res) => {
  try {
    const { status } = req.body;
    const result = await Appointment.updateStatus(req.params.id, status);
    if (!result) return res.status(404).json({ error: 'Appointment not found' });
    res.json({ appointment: result });
  } catch (err) {
    console.error('Appointment update error:', err);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});

// ── Documents ──
router.get('/documents', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, c.name as client_name FROM document_requests d
       LEFT JOIN clients c ON d.client_id = c.id
       ORDER BY d.created_at DESC`
    );
    res.json({ documents: rows });
  } catch (err) {
    console.error('Documents list error:', err);
    res.status(500).json({ error: 'Failed to load documents' });
  }
});

router.put('/documents/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const result = await DocumentRequest.updateStatus(req.params.id, status, notes);
    if (!result) return res.status(404).json({ error: 'Document not found' });
    res.json({ document: result });
  } catch (err) {
    console.error('Document update error:', err);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// ── Users list ──
router.get('/users', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, email, name, role, created_at FROM users ORDER BY created_at DESC');
    res.json({ users: rows });
  } catch (err) {
    console.error('Users list error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// ── Knowledge Base ──
router.get('/knowledge', (req, res) => {
  const topics = Object.entries(LEGAL_TOPICS).map(([key, t]) => ({
    key, title: t.title, content: t.content, law_refs: t.law_refs, keywords: t.keywords,
  }));
  const institutions = Object.entries(INSTITUTIONS).map(([key, i]) => ({
    key, name: i.name, description: i.description, url: i.url, keywords: i.keywords,
  }));
  const serviceCategories = Object.entries(SERVICE_CATEGORIES).map(([key, c]) => ({
    key, name: c.name, emoji: c.emoji, items: c.items,
  }));
  res.json({ topics, institutions, serviceCategories });
});

router.put('/knowledge/topics/:key', (req, res) => {
  const topic = LEGAL_TOPICS[req.params.key];
  if (!topic) return res.status(404).json({ error: 'Topic not found' });
  const { title, content, law_refs, keywords } = req.body;
  if (title) topic.title = title;
  if (content) topic.content = content;
  if (law_refs) topic.law_refs = law_refs;
  if (keywords) topic.keywords = keywords;
  res.json({ topic: { key: req.params.key, ...topic } });
});

// ── Analytics ──
router.get('/analytics', async (req, res) => {
  try {
    const [
      totalMsgs, inbound, outbound, msgs7d, activeClients,
      casesByStatus, casesByType, totalCases, msgsByDay, docsByStatus,
    ] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM messages'),
      pool.query("SELECT COUNT(*) FROM messages WHERE direction = 'inbound'"),
      pool.query("SELECT COUNT(*) FROM messages WHERE direction = 'outbound'"),
      pool.query("SELECT COUNT(*) FROM messages WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(DISTINCT client_id) FROM messages WHERE created_at >= CURRENT_DATE - INTERVAL '30 days' AND client_id IS NOT NULL"),
      pool.query('SELECT status, COUNT(*)::int as count FROM cases GROUP BY status ORDER BY count DESC'),
      pool.query('SELECT case_type, COUNT(*)::int as count FROM cases WHERE case_type IS NOT NULL GROUP BY case_type ORDER BY count DESC'),
      pool.query('SELECT COUNT(*) FROM cases'),
      pool.query(`SELECT DATE(created_at) as day, TO_CHAR(created_at, 'Dy') as day_label, COUNT(*)::int as count
        FROM messages WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
        GROUP BY DATE(created_at), TO_CHAR(created_at, 'Dy') ORDER BY day`),
      pool.query('SELECT status, COUNT(*)::int as count FROM document_requests GROUP BY status ORDER BY count DESC'),
    ]);

    res.json({
      totalMessages: parseInt(totalMsgs.rows[0].count),
      inboundMessages: parseInt(inbound.rows[0].count),
      outboundMessages: parseInt(outbound.rows[0].count),
      messagesLast7Days: parseInt(msgs7d.rows[0].count),
      activeClients: parseInt(activeClients.rows[0].count),
      casesByStatus: casesByStatus.rows,
      casesByType: casesByType.rows,
      totalCases: parseInt(totalCases.rows[0].count),
      messagesByDay: msgsByDay.rows,
      documentsByStatus: docsByStatus.rows,
    });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

module.exports = router;
