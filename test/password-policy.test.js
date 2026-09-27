const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePassword } = require('../src/config/passwordPolicy');

const bad = (pw, ctx = {}) => {
  const r = validatePassword(pw, ctx);
  assert.ok(r, `expected "${pw}" to be rejected`);
  assert.equal(r.code, 'WEAK_PASSWORD');
  return r.error;
};

test('accepts a reasonable password', () => {
  assert.equal(validatePassword('Casa2026x', { username: 'hengi', name: 'Hengi' }), null);
});

test('needs 8+ characters', () => {
  assert.match(bad('ab12cd'), /8 caracteres/);
});

test('needs a letter and a number', () => {
  assert.match(bad('abcdefgh'), /letra y un número/);
  assert.match(bad('12345679'), /letra y un número/);
});

test('rejects common passwords (case-insensitive)', () => {
  assert.match(bad('Password1'), /muy común/);
  assert.match(bad('guru2024'), /muy común/);
  assert.match(bad('Qwerty123'), /muy común/);
});

test('rejects passwords containing the username or a name word', () => {
  assert.match(bad('hengi2026', { username: 'hengi', name: 'Hengi' }), /nombre o usuario/);
  assert.match(bad('Gomez2026', { username: 'pedro', name: 'Pedro Gómez' }), /nombre o usuario/);
});
