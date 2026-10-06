const pool = require('../../db/pool');
const Notification = require('../../models/Notification');

async function activeAdminIds() {
  const a = await pool.query(`SELECT id FROM users WHERE role = 'admin' AND is_active IS NOT FALSE`);
  return a.rows.map((r) => r.id);
}

// El asignado del cliente (si existe) o, si no, cada admin activo.
async function assigneeOrAdmins(assignedTo) {
  if (assignedTo) {
    const u = await pool.query('SELECT id, name FROM users WHERE id = $1', [assignedTo]);
    if (u.rows[0]) return { asignado: u.rows[0].name || null, recipients: [u.rows[0].id] };
  }
  return { asignado: null, recipients: await activeAdminIds() };
}

// Un fallo al notificar nunca rompe la herramienta.
async function notifyUsers(userIds, { type, title, message, link, metadata }) {
  for (const userId of userIds) {
    try {
      await Notification.create({ userId, type, title, message, link, metadata: metadata || {} });
    } catch (err) {
      console.error('[Agent] notificación falló:', err.code || err.name || 'error');
    }
  }
}

module.exports = { activeAdminIds, assigneeOrAdmins, notifyUsers };
