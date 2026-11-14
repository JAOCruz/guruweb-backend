const test = require('node:test');
const assert = require('node:assert/strict');
const { COLOR_KEYS, AVATAR_KEYS, ADMIN_ONLY_AVATAR, DEFAULT_ENABLED_AVATARS, validateAppearance, closestColorOwner } = require('../src/config/appearance');

test('palette has 12 colors in fixed order', () => {
  assert.deepEqual(COLOR_KEYS, ['green','yellow','red','purple','orange','pink','teal','cyan','blue','indigo','lime','brown']);
});

test('avatars: animal catalog + owl', () => {
  assert.ok(AVATAR_KEYS.length >= 90);
  assert.ok(AVATAR_KEYS.includes('cow'));
  assert.equal(ADMIN_ONLY_AVATAR, 'owl');
});

test('requires at least one field', () => {
  const r = validateAppearance({ role: 'digitador' });
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

test('valid color and avatar', () => {
  assert.deepEqual(validateAppearance({ role: 'digitador', color: 'teal', avatar: 'cow' }), { ok: true });
});

test('unknown color → 400 INVALID_COLOR', () => {
  for (const color of ['magenta', '#ff00', '#gg0000', 'rgb(1,2,3)']) {
    const r = validateAppearance({ role: 'digitador', color });
    assert.equal(r.status, 400, color);
    assert.equal(r.code, 'INVALID_COLOR');
  }
});

test('any #RRGGBB color is valid, like picking from a paint palette', () => {
  assert.deepEqual(validateAppearance({ role: 'digitador', color: '#FF8800' }), { ok: true });
  assert.deepEqual(validateAppearance({ role: 'digitador', color: '#0a1b2c' }), { ok: true });
});

test('closestColorOwner finds someone whose color looks almost the same', () => {
  const others = [{ name: 'Hengi', color: 'blue' }, { name: 'Ana', color: '#123456' }];
  assert.equal(closestColorOwner('#3c83f5', others)?.name, 'Hengi'); // next to blue #3b82f6
  assert.equal(closestColorOwner('#13355a', others)?.name, 'Ana');
  assert.equal(closestColorOwner('#ff8800', others), null);
  assert.equal(closestColorOwner('indigo', [{ name: 'Hengi', color: 'blue' }]), null); // palette colors never clash with each other
});

test('null color → 400', () => {
  assert.equal(validateAppearance({ role: 'admin', color: null }).status, 400);
});

test('unknown avatar → 400 INVALID_AVATAR', () => {
  assert.equal(validateAppearance({ role: 'digitador', avatar: 'dinosaur' }).code, 'INVALID_AVATAR');
});

test('avatar null clears → ok', () => {
  assert.deepEqual(validateAppearance({ role: 'digitador', avatar: null }), { ok: true });
});

test('owl for non-admin → 403 OWL_RESERVED', () => {
  const r = validateAppearance({ role: 'digitador', avatar: 'owl' });
  assert.equal(r.status, 403);
  assert.equal(r.code, 'OWL_RESERVED');
  assert.equal(r.error, 'Reservado para el admin');
});

test('owl for admin → ok', () => {
  assert.deepEqual(validateAppearance({ role: 'admin', avatar: 'owl' }), { ok: true });
});

test('catalog has animal faces and full-body animals; the 24 original faces are enabled by default', () => {
  for (const key of ['koala', 'monkey', 'hamster', 'mouse', 'wolf', 'boar', 'unicorn', 'dragon', 'raccoon', 'zebra',
    'sheep', 'goat', 'duck', 'turtle', 'dolphin', 'penguin', 'parrot', 'bee', 'butterfly', 'elephant']) {
    assert.ok(AVATAR_KEYS.includes(key), key);
  }
  assert.equal(DEFAULT_ENABLED_AVATARS.length, 24);
  assert.ok(!DEFAULT_ENABLED_AVATARS.includes('owl'));
  assert.ok(DEFAULT_ENABLED_AVATARS.every((k) => AVATAR_KEYS.includes(k)));
  assert.equal(new Set(AVATAR_KEYS).size, AVATAR_KEYS.length);
});

test('employees can only pick enabled animals; the admin can pick any', () => {
  const enabledAvatars = ['cow', 'sheep'];
  assert.deepEqual(validateAppearance({ role: 'digitador', avatar: 'sheep', enabledAvatars }), { ok: true });
  const r = validateAppearance({ role: 'digitador', avatar: 'goat', enabledAvatars });
  assert.equal(r.status, 403);
  assert.equal(r.code, 'AVATAR_DISABLED');
  assert.deepEqual(validateAppearance({ role: 'admin', avatar: 'goat', enabledAvatars }), { ok: true });
  assert.equal(validateAppearance({ role: 'digitador', avatar: 'dinosaurio', enabledAvatars }).code, 'INVALID_AVATAR');
});
