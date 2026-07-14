const pool = require('../db/pool');

const SETTINGS_KEY = 'bot_settings';

const DEFAULTS = {
  botActive: true,
  botMode: 'all',
  enabledPhones: [],
  manualPhones: [],
  assignmentMode: 'automatic',
};

async function load() {
  try {
    const { rows } = await pool.query(
      'SELECT value FROM wa_bot_state WHERE key = $1',
      [SETTINGS_KEY]
    );
    if (rows.length > 0) {
      console.log('[Settings] Loaded bot settings from database');
      return { ...DEFAULTS, ...rows[0].value };
    }
  } catch (err) {
    console.error('[Settings] Error loading settings:', err.message);
  }
  console.log('[Settings] Using default bot settings');
  return { ...DEFAULTS };
}

async function save(settings) {
  try {
    const data = {
      botActive: settings.botActive,
      botMode: settings.botMode,
      enabledPhones: settings.enabledPhones,
      manualPhones: settings.manualPhones,
      assignmentMode: settings.assignmentMode,
    };
    await pool.query(
      `INSERT INTO wa_bot_state (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = NOW()`,
      [SETTINGS_KEY, JSON.stringify(data)]
    );
  } catch (err) {
    console.error('[Settings] Error saving settings:', err.message);
  }
}

module.exports = { load, save };
