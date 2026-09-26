const test = require('node:test');
const assert = require('node:assert/strict');
const { COLOR_KEYS, AVATAR_KEYS, ADMIN_ONLY_AVATAR, validateAppearance } = require('../src/config/appearance');

test('palette has 12 colors in fixed order', () => {
  assert.deepEqual(COLOR_KEYS, ['green','yellow','red','purple','orange','pink','teal','cyan','blue','indigo','lime','brown']);
});

test('avatars: 24 animals + owl', () => {
  assert.equal(AVATAR_KEYS.length, 25);
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
  const r = validateAppearance({ role: 'digitador', color: '#ff0000' });
  assert.equal(r.status, 400);
  assert.equal(r.code, 'INVALID_COLOR');
});

test('null color → 400', () => {
  assert.equal(validateAppearance({ role: 'admin', color: null }).status, 400);
});

test('unknown avatar → 400 INVALID_AVATAR', () => {
  assert.equal(validateAppearance({ role: 'digitador', avatar: 'unicorn' }).code, 'INVALID_AVATAR');
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
