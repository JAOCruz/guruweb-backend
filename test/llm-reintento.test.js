// La IA: si Google está saturado (503) se reintenta una vez el modelo principal antes del de respaldo,
// y el log guarda el motivo (código y mensaje), sin la clave.
require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateWithFallback, _setRetryDelay } = require('../src/llm/generate');
const { model, fallbackModel } = require('../src/llm/client');

const E503 = () => new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=AIzaSECRETSECRETSECRETSECRET: [503 Service Unavailable] This model is currently experiencing high demand.');

function captureLogs() {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  return { lines, restore: () => { console.log = orig; } };
}
test.beforeEach(() => _setRetryDelay(1));

test('503 del principal: espera y lo reintenta una vez; si responde, no usa el de respaldo', async () => {
  const calls = [];
  const r = await generateWithFallback(async (m) => {
    calls.push(m === model ? 'principal' : 'respaldo');
    if (calls.length === 1) throw E503();
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.deepEqual(calls, ['principal', 'principal']);
});

test('si el reintento también falla, pasa al de respaldo', async () => {
  const calls = [];
  const r = await generateWithFallback(async (m) => {
    calls.push(m === model ? 'principal' : 'respaldo');
    if (m === model) throw E503();
    return 'ok';
  });
  assert.equal(r, 'ok');
  assert.deepEqual(calls, ['principal', 'principal', 'respaldo']);
});

test('el log trae el código y el motivo, nunca la clave', async () => {
  const log = captureLogs();
  try {
    await generateWithFallback(async () => { throw E503(); });
  } finally { log.restore(); }
  const all = log.lines.join('\n');
  assert.match(all, /503 Service Unavailable/);
  assert.match(all, /high demand/);
  assert.doesNotMatch(all, /AIza|SECRET/);
});

test('un error de cuota (429) no se reintenta en el principal', async () => {
  const calls = [];
  await generateWithFallback(async (m) => {
    calls.push(m === model ? 'principal' : 'respaldo');
    throw new Error('[GoogleGenerativeAI Error]: [429 Too Many Requests] RESOURCE_EXHAUSTED');
  });
  assert.deepEqual(calls, ['principal', 'respaldo']);
  assert.ok(fallbackModel);
});
