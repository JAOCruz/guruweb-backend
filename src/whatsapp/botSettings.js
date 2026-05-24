const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '../../data/bot-settings.json');

const DEFAULTS = {
  botActive: true,
  botMode: 'all',
  enabledPhones: [],
  manualPhones: [],
  assignmentMode: 'automatic',
};

function load() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
      const data = JSON.parse(raw);
      console.log('[Settings] Loaded bot settings from disk');
      return { ...DEFAULTS, ...data };
    }
  } catch (err) {
    console.error('[Settings] Error loading settings:', err.message);
  }
  return { ...DEFAULTS };
}

function save(settings) {
  try {
    const data = {
      botActive: settings.botActive,
      botMode: settings.botMode,
      enabledPhones: settings.enabledPhones,
      manualPhones: settings.manualPhones,
      assignmentMode: settings.assignmentMode,
    };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[Settings] Error saving settings:', err.message);
  }
}

module.exports = { load, save };
