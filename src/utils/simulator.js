/**
 * Simulator helpers
 * The simulator uses phone identifiers like 'simulate_user_1' or session IDs.
 * Records created from simulator interactions are tagged with source='simulator'
 * so they can be filtered, reviewed, and bulk-deleted before go-live.
 */

const SIMULATOR_PREFIXES = ['simulate_', 'sim_'];

function isSimulatorPhone(phone) {
  if (!phone) return false;
  const p = String(phone).toLowerCase();
  return SIMULATOR_PREFIXES.some(prefix => p.startsWith(prefix));
}

function getSource(phone) {
  return isSimulatorPhone(phone) ? 'simulator' : 'whatsapp';
}

module.exports = { isSimulatorPhone, getSource };
