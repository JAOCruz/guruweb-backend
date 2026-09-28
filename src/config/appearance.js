// Keys only — hex values and emoji live in the frontend (dashboard src/lib/userColors.ts).
const COLOR_KEYS = ['green', 'yellow', 'red', 'purple', 'orange', 'pink', 'teal', 'cyan', 'blue', 'indigo', 'lime', 'brown'];

// Animal catalog: faces and full-body animals. Keys only; emoji and labels live in the
// frontend (dashboard src/lib/userColors.ts) and must stay in sync. Very new emoji
// (goose, moose, donkey, jellyfish…) are left out: older computers show them as squares.
const FACE_AVATARS = [
  'cow', 'cat', 'dog', 'horse', 'pig', 'rabbit', 'rooster', 'lion', 'tiger', 'bear', 'panda', 'fox',
  'frog', 'giraffe', 'koala', 'monkey', 'hamster', 'mouse', 'wolf', 'boar', 'unicorn', 'dragon', 'raccoon', 'zebra',
];
const MORE_AVATARS = [
  // mammals
  'monkey_full', 'gorilla', 'orangutan', 'dog_full', 'poodle', 'guide_dog', 'cat_full', 'tiger_full', 'leopard',
  'horse_full', 'deer', 'ox', 'water_buffalo', 'cow_full', 'pig_full', 'ram', 'sheep', 'goat', 'camel',
  'two_hump_camel', 'llama', 'kangaroo', 'sloth', 'otter', 'skunk', 'badger', 'elephant', 'rhino', 'hippo',
  'mouse_full', 'rat', 'rabbit_full', 'chipmunk', 'hedgehog', 'bat',
  // birds
  'turkey', 'chicken_full', 'hatching_chick', 'baby_chick', 'front_chick', 'bird', 'penguin', 'dove', 'eagle',
  'duck', 'swan', 'flamingo', 'peacock', 'parrot',
  // reptiles
  'crocodile', 'turtle', 'lizard', 'snake', 'dragon_full', 'sauropod', 't_rex',
  // sea
  'spouting_whale', 'whale', 'dolphin', 'fish', 'tropical_fish', 'blowfish', 'shark', 'octopus', 'crab',
  'lobster', 'shrimp', 'squid',
  // bugs
  'snail', 'butterfly', 'caterpillar', 'ant', 'bee', 'ladybug', 'cricket', 'spider', 'scorpion', 'mosquito',
];
const AVATAR_KEYS = [...FACE_AVATARS, ...MORE_AVATARS, 'owl'];

// Available to employees until the admin changes it (the owl is always admin-only)
const DEFAULT_ENABLED_AVATARS = [...FACE_AVATARS];

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

// enabledAvatars: animals the admin made available; currentAvatar: the user's own, which
// they may keep even if it was disabled later.
function validateAppearance({ role, color, avatar, enabledAvatars = DEFAULT_ENABLED_AVATARS, currentAvatar = null }) {
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
  if (avatar && role !== 'admin' && avatar !== currentAvatar && !enabledAvatars.includes(avatar)) {
    return fail(403, 'AVATAR_DISABLED', 'Ese animal no está disponible');
  }
  return { ok: true };
}

module.exports = { COLOR_KEYS, AVATAR_KEYS, ADMIN_ONLY_AVATAR, DEFAULT_ENABLED_AVATARS, SEED_COLORS, validateAppearance };
