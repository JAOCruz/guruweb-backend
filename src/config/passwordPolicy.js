// Rules for NEW passwords (existing ones keep working). Messages are shown to staff.
const COMMON = new Set([
  '12345678', '123456789', '1234567890', '11111111', '00000000', '87654321', '12341234', '11223344',
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'contraseña', 'contrasena', 'contrasena1',
  'qwerty12', 'qwerty123', 'qwertyuiop', 'asdfgh12', 'asdf1234', 'zxcvbnm1', 'abcd1234', 'abc12345', 'abcdef12',
  'iloveyou1', 'admin123', 'admin1234', 'administrador', 'welcome1', 'bienvenido1', 'hola1234', 'holamundo1',
  'dominicana1', 'republica1', 'santodomingo1', 'teamo123', 'amor1234', 'dios1234', 'jesus123', 'familia1',
  'guru1234', 'guru2024', 'guru2025', 'guru2026', 'gurusoluciones', 'gurusoluciones1', 'soluciones1', 'soluciones123',
  'empleado1', 'usuario1', 'usuario123', 'cambiame1', 'temporal1', 'temporal123', 'prueba123', 'test1234',
]);

function normalize(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function fail(error) {
  return { code: 'WEAK_PASSWORD', error };
}

function validatePassword(password, { username, name } = {}) {
  const pw = String(password || '');
  if (pw.length < 8) return fail('La contraseña debe tener al menos 8 caracteres');
  if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]/.test(pw) || !/\d/.test(pw)) {
    return fail('La contraseña debe tener al menos una letra y un número');
  }
  const plain = normalize(pw);
  if (COMMON.has(plain)) return fail('Esa contraseña es muy común; elige otra');
  const personal = [username, ...String(name || '').split(/\s+/)]
    .map(normalize)
    .filter((w) => w && w.length >= 3);
  if (personal.some((w) => plain.includes(w))) {
    return fail('La contraseña no puede contener tu nombre o usuario');
  }
  return null;
}

module.exports = { validatePassword };
