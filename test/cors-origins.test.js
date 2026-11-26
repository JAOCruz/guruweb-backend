// Sitios que pueden usar la API con sesión. El backend de prueba (Railway, entorno dev) agrega su dashboard con
// ALLOWED_ORIGINS sin tocar la lista fija de producción (Jay, 2026-11-26).
const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedOrigins } = require('../src/utils/corsOrigins');

test('sin ALLOWED_ORIGINS queda la lista fija de producción', () => {
  const list = allowedOrigins({});
  assert.ok(list.includes('https://guruweb-dashboard-prod.netlify.app'));
  assert.ok(!list.includes('https://guru-dashboard-prueba.netlify.app'));
});

test('ALLOWED_ORIGINS agrega sitios separados por coma, sin espacios ni barra final', () => {
  const list = allowedOrigins({ ALLOWED_ORIGINS: ' https://guru-dashboard-prueba.netlify.app/ , https://otro.example.com,' });
  assert.ok(list.includes('https://guru-dashboard-prueba.netlify.app'));
  assert.ok(list.includes('https://otro.example.com'));
  assert.ok(list.includes('https://guruweb-dashboard-prod.netlify.app'));
  assert.ok(!list.includes(''));
});
