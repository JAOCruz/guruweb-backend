const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const { resetCache, getSystemPrompt } = require('../llm/systemPrompt');
const pool = require('../db/pool');
const { runMigrations } = require('../db/runMigrations');

const router = express.Router();
router.use(authenticate);

// Hot-reload system prompt without restarting the bot
router.post('/reload-prompt', requireRole('admin'), (req, res) => {
  try {
    resetCache();
    // Trigger rebuild by calling getSystemPrompt once
    const prompt = getSystemPrompt();
    res.json({
      ok: true,
      message: 'System prompt reloaded successfully',
      promptLength: prompt.length
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString()
  });
});

// ── Admin-only: Assign client to digitador ──
router.post('/assign-client', requireRole('admin'), async (req, res) => {
  try {
    const { clientId, userId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId is required' });

    // userId = null means unassign
    const { rows } = await pool.query(
      'UPDATE clients SET assigned_to = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [userId || null, clientId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Client not found' });
    res.json({ client: rows[0], message: 'Client assigned successfully' });
  } catch (err) {
    console.error('Assign client error:', err);
    res.status(500).json({ error: 'Failed to assign client' });
  }
});

// ── Admin-only: Get all users (for assignment dropdown) ──
router.get('/users', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, email, name, role, created_at FROM users ORDER BY name ASC'
    );
    res.json({ users: rows });
  } catch (err) {
    console.error('Admin users list error:', err);
    res.status(500).json({ error: 'Failed to list users' });
  }
});

// ── Admin-only: Get digitadores only (for assignment dropdown) ──
router.get('/digitadores', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, email, name, role FROM users WHERE role = 'digitador' ORDER BY name ASC"
    );
    res.json({ digitadores: rows });
  } catch (err) {
    console.error('Admin digitadores error:', err);
    res.status(500).json({ error: 'Failed to list digitadores' });
  }
});

// ── Admin-only: Digitador online presence ──
// Online = last_seen within the last 5 minutes
router.get('/online-users', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, name, email, role, last_seen,
             (last_seen IS NOT NULL AND last_seen > NOW() - INTERVAL '5 minutes') AS online
      FROM users
      WHERE role = 'digitador'
      ORDER BY name ASC
    `);
    res.json({ digitadores: rows });
  } catch (err) {
    console.error('Online users error:', err);
    res.status(500).json({ error: 'Failed to get online status' });
  }
});

// ── Admin-only: Get unassigned clients ──
router.get('/clients/unassigned', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM clients WHERE assigned_to IS NULL ORDER BY created_at DESC'
    );
    res.json({ clients: rows });
  } catch (err) {
    console.error('Unassigned clients error:', err);
    res.status(500).json({ error: 'Failed to list unassigned clients' });
  }
});

// ── Admin-only: Run pending database migrations ──
router.post('/run-migrations', requireRole('admin'), async (req, res) => {
  try {
    const result = await runMigrations();
    res.json({
      ok: true,
      message: `${result.ran.length} migration(s) applied`,
      ran: result.ran.map((r) => r.filename),
      skipped: result.skipped,
    });
  } catch (err) {
    console.error('Run migrations error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
