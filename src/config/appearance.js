// Keys only — hex values and emoji live in the frontend (dashboard src/lib/userColors.ts).
const COLOR_KEYS = ['green', 'yellow', 'red', 'purple', 'orange', 'pink', 'teal', 'cyan', 'blue', 'indigo', 'lime', 'brown'];

const AVATAR_KEYS = [
  'cow', 'cat', 'dog', 'horse', 'pig', 'sheep', 'goat', 'rooster', 'duck', 'rabbit', 'turtle', 'dolphin',
  'lion', 'tiger', 'bear', 'panda', 'fox', 'frog', 'penguin', 'parrot', 'bee', 'butterfly', 'elephant', 'giraffe',
  'owl',
];

const ADMIN_ONLY_AVATAR = 'owl';

// Current hardcoded dashboard colors, keyed by users.data_column
const SEED_COLORS = {
  HENGI: 'green',
  MARLENI: 'yellow',
  ISRAEL: 'red',
  THAICAR: 'purple',
  AUXILIAR_I: 'orange',
  AUXILIAR_II: 'pink',
};

function fail(status, code, error) {
  return { ok: false, status, code, error };
}

function validateAppearance({ role, color, avatar }) {
  if (color === undefined && avatar === undefined) {
    return fail(400, 'NOTHING_TO_UPDATE', 'Debes enviar color o avatar');
  }
  if (color !== undefined && !COLOR_KEYS.includes(color)) {
    return fail(400, 'INVALID_COLOR', 'Color no válido');
  }
  if (avatar !== undefined && avatar !== null && !AVATAR_KEYS.includes(avatar)) {
    return fail(400, 'INVALID_AVATAR', 'Avatar no válido');
  }
  if (avatar === ADMIN_ONLY_AVATAR && role !== 'admin') {
    return fail(403, 'OWL_RESERVED', 'Reservado para el admin');
  }
  return { ok: true };
}

module.exports = { COLOR_KEYS, AVATAR_KEYS, ADMIN_ONLY_AVATAR, SEED_COLORS, validateAppearance };
