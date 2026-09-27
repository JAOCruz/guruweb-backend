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

// ── Admin-only: user management ──
const User = require('../models/User');
const { invalidateUserStatus } = require('../middleware/auth');

const ROLES = ['admin', 'digitador', 'auxiliar'];
const { validatePassword } = require('../config/passwordPolicy');
const { normalizeBirthDate, formatBirthDate } = require('../config/birthDate');
const { logActivity, listActivity, safeLog } = require('../services/activityLog');

const ROLE_LABEL = { admin: 'Admin', digitador: 'Digitador', auxiliar: 'Auxiliar', employee: 'Digitador' };
const displayName = (u) => (u && (u.name || u.username)) || 'usuario';

function sendError(res, status, code, error) {
  return res.status(status).json({ error, code });
}

function toAdminUser(u) {
  if (!u) return u;
  const { password_hash, ...rest } = u;
  if ('birth_date' in rest) rest.birth_date = formatBirthDate(rest.birth_date);
  return rest;
}

function validateUserInput(body, { requirePassword }) {
  const { name, username, role, temp_password, birth_date } = body || {};
  if (!name || !String(name).trim() || !username || !String(username).trim()) {
    return ['NAME_REQUIRED', 'Nombre y usuario son obligatorios'];
  }
  if (!ROLES.includes(role)) return ['INVALID_ROLE', 'Rol no válido'];
  if (birth_date !== undefined) {
    const bd = normalizeBirthDate(birth_date);
    if (!bd.ok) return [bd.code, bd.error];
  }
  if (requirePassword) {
    const weak = validatePassword(temp_password, { username, name });
    if (weak) return [weak.code, weak.error];
  }
  return null;
}

function handleDbError(res, err, context) {
  // Production has both the case-insensitive index and the original UNIQUE(username)/UNIQUE(email)
  if (err.code === '23505' && /username/.test(err.constraint || '')) {
    return sendError(res, 409, 'USERNAME_TAKEN', 'Ese usuario ya existe');
  }
  if (err.code === '23505' && /email/.test(err.constraint || '')) {
    return sendError(res, 409, 'EMAIL_TAKEN', 'Ese email ya está en uso');
  }
  if (err.code === 'INVALID_REASSIGN') {
    return sendError(res, 400, 'INVALID_REASSIGN', 'Elige un usuario activo distinto para reasignar');
  }
  console.error(`${context} error:`, err);
  return res.status(500).json({ error: 'No se pudo completar la operación' });
}

router.get('/users', requireRole('admin'), async (req, res) => {
  try {
    // Default 'active': existing assignment dropdowns call this without a status
    const status = ['active', 'inactive', 'all'].includes(req.query.status) ? req.query.status : 'active';
    const users = await User.adminList(status);
    res.json({ users: users.map(toAdminUser) });
  } catch (err) {
    handleDbError(res, err, 'Admin users list');
  }
});

router.post('/users', requireRole('admin'), async (req, res) => {
  const invalid = validateUserInput(req.body, { requirePassword: true });
  if (invalid) return sendError(res, 400, ...invalid);
  try {
    const { name, username, email, role, in_payroll, temp_password, birth_date } = req.body;
    const user = await User.adminCreate({
      name: String(name).trim(), username: String(username).trim(), email, role, in_payroll: !!in_payroll, temp_password,
      birth_date: birth_date === undefined ? null : normalizeBirthDate(birth_date).value,
    });
    await logActivity(req, {
      category: 'usuarios', action: 'user.create', entityType: 'user', entityId: user.id,
      summary: `Creó el usuario ${user.username} (${displayName(user)}, ${ROLE_LABEL[user.role] || user.role})`,
      details: { username: user.username, name: user.name, role: user.role, in_payroll: user.in_payroll },
    });
    res.status(201).json({ user: toAdminUser(user) });
  } catch (err) {
    handleDbError(res, err, 'Admin create user');
  }
});

router.put('/users/:id', requireRole('admin'), async (req, res) => {
  const invalid = validateUserInput(req.body, { requirePassword: false });
  if (invalid) return sendError(res, 400, ...invalid);
  try {
    const id = Number(req.params.id);
    const target = await User.findById(id);
    if (!target) return sendError(res, 404, 'USER_NOT_FOUND', 'Usuario no encontrado');
    const { name, username, email, role, in_payroll, birth_date } = req.body;
    if (target.role === 'admin' && role !== 'admin') {
      if (id === req.user.id) return sendError(res, 400, 'CANNOT_DEMOTE_SELF', 'No puedes quitarte el rol de administrador');
      if (target.is_active && (await User.countActiveAdmins(id)) === 0) {
        return sendError(res, 400, 'LAST_ADMIN', 'Debe quedar al menos un administrador activo');
      }
    }
    const user = await User.adminUpdate(id, {
      name: String(name).trim(), username: String(username).trim(), email, role, in_payroll: !!in_payroll,
      birth_date: birth_date === undefined ? undefined : normalizeBirthDate(birth_date).value,
    });
    invalidateUserStatus(id);
    await safeLog(async () => {
      const changes = {};
      const before = toAdminUser(target);
      const after = toAdminUser(user);
      for (const key of ['name', 'username', 'email', 'role', 'in_payroll', 'birth_date']) {
        if ((before[key] ?? null) !== (after[key] ?? null)) changes[key] = { antes: before[key] ?? null, despues: after[key] ?? null };
      }
      const roleNote = changes.role ? ` — rol: ${ROLE_LABEL[target.role] || target.role} → ${ROLE_LABEL[user.role] || user.role}` : '';
      await logActivity(req, {
        category: 'usuarios', action: 'user.update', entityType: 'user', entityId: id,
        summary: `Editó el usuario ${displayName(user)}${roleNote}`, details: { cambios: changes },
      });
    });
    res.json({ user: toAdminUser(user) });
  } catch (err) {
    handleDbError(res, err, 'Admin update user');
  }
});

router.post('/users/:id/temp-password', requireRole('admin'), async (req, res) => {
  const { temp_password } = req.body || {};
  try {
    const id = Number(req.params.id);
    const target = await User.findById(id);
    if (!target) return sendError(res, 404, 'USER_NOT_FOUND', 'Usuario no encontrado');
    const weak = validatePassword(temp_password, { username: target.username, name: target.name });
    if (weak) return sendError(res, 400, weak.code, weak.error);
    const user = await User.setTempPassword(id, temp_password);
    if (!user) return sendError(res, 404, 'USER_NOT_FOUND', 'Usuario no encontrado');
    invalidateUserStatus(id);
    await logActivity(req, {
      category: 'usuarios', action: 'user.temp_password', entityType: 'user', entityId: id,
      summary: `Puso una contraseña temporal a ${displayName(user)}`,
    });
    res.json({ user: toAdminUser(user) });
  } catch (err) {
    handleDbError(res, err, 'Admin temp password');
  }
});

// ── Admin-only: activity log ──
router.get('/activity', requireRole('admin'), async (req, res) => {
  try {
    const q = req.query;
    const page = Math.max(Number(q.page) || 1, 1);
    const pageSize = Math.min(Math.max(Number(q.page_size) || 50, 1), 100);
    const { items, total } = await listActivity({
      category: q.category || undefined,
      actorId: q.actor_id || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
      q: q.q || undefined,
      page,
      pageSize,
    });
    res.json({ items, total, page, page_size: pageSize });
  } catch (err) {
    handleDbError(res, err, 'Admin activity list');
  }
});

router.get('/users/:id/assignments', requireRole('admin'), async (req, res) => {
  try {
    res.json(await User.countAssignments(Number(req.params.id)));
  } catch (err) {
    handleDbError(res, err, 'Admin assignments');
  }
});

router.post('/users/:id/deactivate', requireRole('admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const target = await User.findById(id);
    if (!target) return sendError(res, 404, 'USER_NOT_FOUND', 'Usuario no encontrado');
    if (id === req.user.id) return sendError(res, 400, 'CANNOT_DEACTIVATE_SELF', 'No puedes desactivarte a ti mismo');
    if (target.role === 'admin' && (await User.countActiveAdmins(id)) === 0) {
      return sendError(res, 400, 'LAST_ADMIN', 'Debe quedar al menos un administrador activo');
    }
    const reassignTo = req.body?.reassign_to == null || req.body.reassign_to === '' ? null : Number(req.body.reassign_to);
    const counts = await User.countAssignments(id);
    const user = await User.deactivate(id, reassignTo, req.user.id);
    invalidateUserStatus(id);
    await safeLog(async () => {
      const receiver = reassignTo ? await User.findById(reassignTo) : null;
      await logActivity(req, {
        category: 'usuarios', action: 'user.deactivate', entityType: 'user', entityId: id,
        summary: `Desactivó a ${displayName(target)}; ${counts.clients} clientes/chats y ${counts.cases} casos pasaron a ${receiver ? displayName(receiver) : 'Sin asignar'}`,
        details: { reassigned_to: reassignTo, clients: counts.clients, cases: counts.cases },
      });
    });
    res.json({ user: toAdminUser(user) });
  } catch (err) {
    handleDbError(res, err, 'Admin deactivate user');
  }
});

router.post('/users/:id/reactivate', requireRole('admin'), async (req, res) => {
  try {
    const id = Number(req.params.id);
    const user = await User.reactivate(id);
    if (!user) return sendError(res, 404, 'USER_NOT_FOUND', 'Usuario no encontrado');
    invalidateUserStatus(id);
    await logActivity(req, {
      category: 'usuarios', action: 'user.reactivate', entityType: 'user', entityId: id,
      summary: `Reactivó a ${displayName(user)}`,
    });
    res.json({ user: toAdminUser(user) });
  } catch (err) {
    handleDbError(res, err, 'Admin reactivate user');
  }
});

// ── Admin-only: Get digitadores only (for assignment dropdown) ──
router.get('/digitadores', requireRole('admin'), async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, username, email, name, role FROM users WHERE role = 'digitador' AND is_active = TRUE ORDER BY COALESCE(name, username) ASC"
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
