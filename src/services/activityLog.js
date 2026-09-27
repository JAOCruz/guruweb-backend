// Activity log: who did what and when (admin "Actividad" page).
// logActivity never throws — recording must never block the action itself.
const pool = require('../db/pool');

const SECRET_KEYS = new Set(['password', 'temp_password', 'currentPassword', 'newPassword', 'turnstileToken', 'token', 'password_hash']);
const DAY_MS = 24 * 60 * 60 * 1000;

function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (!SECRET_KEYS.has(k)) out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

async function logActivity(req, { category, action, entityType = null, entityId = null, summary, details = null, actor = null }) {
  try {
    const who = req?.user || actor || {};
    await pool.query(
      `INSERT INTO activity_log (actor_id, actor_name, category, action, entity_type, entity_id, summary, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        who.id ?? null,
        who.username ?? who.name ?? null,
        category,
        action,
        entityType,
        entityId == null ? null : String(entityId),
        summary,
        details == null ? null : JSON.stringify(stripSecrets(details)),
        req?.ip ?? null,
      ]
    );
  } catch (err) {
    console.error('[activity] could not record', action, '-', err.message);
  }
}

async function listActivity({ category, actorId, from, to, q, page = 1, pageSize = 50 } = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
  if (category) add('a.category = ?', category);
  if (actorId) add('a.actor_id = ?', Number(actorId));
  if (from) add('a.created_at >= ?', new Date(from));
  if (to) add('a.created_at <= ?', new Date(to));
  if (q) add('a.summary ILIKE ?', `%${q}%`);
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const size = Math.min(Math.max(Number(pageSize) || 50, 1), 100);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * size;

  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM activity_log a ${whereSql}`, params)).rows[0].n;
  const { rows } = await pool.query(
    `SELECT a.id, a.created_at, a.actor_id, a.actor_name, a.category, a.action, a.entity_type, a.entity_id,
            a.summary, a.details, a.ip,
            COALESCE(NULLIF(u.name, ''), u.username, a.actor_name) AS actor_display_name,
            u.color AS actor_color, u.avatar AS actor_avatar
     FROM activity_log a
     LEFT JOIN users u ON u.id = a.actor_id
     ${whereSql}
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT ${size} OFFSET ${offset}`,
    params
  );
  return { items: rows, total };
}

async function purgeOld(days = 365) {
  const { rowCount } = await pool.query(
    `DELETE FROM activity_log WHERE created_at < NOW() - ($1 || ' days')::interval`,
    [String(days)]
  );
  return rowCount;
}

function startActivityRetention(days = 365) {
  const run = () =>
    purgeOld(days)
      .then((n) => n && console.log(`[activity] purged ${n} entries older than ${days} days`))
      .catch((err) => console.error('[activity] purge failed:', err.message));
  run();
  setInterval(run, DAY_MS).unref();
}

module.exports = { logActivity, listActivity, purgeOld, startActivityRetention, stripSecrets };
