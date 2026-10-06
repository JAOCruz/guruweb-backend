const test = require('node:test');
const assert = require('node:assert/strict');
const { assertLocalUrl } = require('./helpers/db');

test('una base remota se rechaza sin mostrar la contraseña', () => {
  assert.throws(() => assertLocalUrl('postgresql://u:secret@db.example.com:5432/x'), (e) => {
    assert.ok(!e.message.includes('secret'));
    assert.ok(!e.message.includes('u:'));
    assert.match(e.message, /db\.example\.com:5432\/x/);
    return true;
  });
});
test('el host se ancla: xlocalhost y localhost en la ruta se rechazan', () => {
  assert.throws(() => assertLocalUrl('postgresql://xlocalhost:5432/x'));
  assert.throws(() => assertLocalUrl('postgresql://evil.com/localhost/'));
  assert.throws(() => assertLocalUrl('postgresql://localhost@evil.com:5432/x'));
});
test('las bases locales se aceptan, con o sin credenciales', () => {
  assertLocalUrl('postgresql://localhost:5432/guru_test');
  assertLocalUrl('postgres://u:p@127.0.0.1:5432/guru_test');
});
