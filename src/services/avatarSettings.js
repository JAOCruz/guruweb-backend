const pool = require('../db/pool');
const { AVATAR_KEYS, ADMIN_ONLY_AVATAR, DEFAULT_ENABLED_AVATARS } = require('../config/appearance');

// Animals the admin made available to employees. Before the migration runs, the defaults apply.
async function getEnabledAvatars() {
  try {
    const { rows } = await pool.query('SELECT key FROM avatar_settings WHERE enabled = TRUE');
    return rows.map((r) => r.key).filter((k) => AVATAR_KEYS.includes(k));
  } catch (err) {
    if (err.code === '42P01') return [...DEFAULT_ENABLED_AVATARS]; // table not created yet
    throw err;
  }
}

function isToggleable(key) {
  return AVATAR_KEYS.includes(key) && key !== ADMIN_ONLY_AVATAR;
}

async function setAvatarEnabled(key, enabled, actorId) {
  await pool.query(
    `INSERT INTO avatar_settings (key, enabled, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, enabled, actorId]
  );
}

module.exports = { getEnabledAvatars, setAvatarEnabled, isToggleable };
