// Prueba de las fotos de Leandro (2026-11-25): Gemini devolvió una respuesta vacía para una foto legible y el bot
// le pidió al cliente que la mandara otra vez. Una respuesta vacía se reintenta una vez antes de rendirse.
require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { model, fallbackModel } = require('../src/llm/client');
const { analyzeDocument } = require('../src/llm/mediaAnalysis');
delete process.env.ANTHROPIC_API_KEY; // estas pruebas son del camino de Gemini

const resp = (text, finishReason = 'STOP') => ({ response: { text: () => text, candidates: [{ finishReason }] } });
const foto = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vacio-')), 'f.jpg');
fs.writeFileSync(foto, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

test('respuesta vacía: se reintenta una vez y se usa el análisis del segundo intento', async (t) => {
  const calls = [];
  t.mock.method(model, 'generateContent', async () => { calls.push('principal'); return calls.length === 1 ? resp('') : resp('TIPO: CARTA\nEXTENSION: 1 página, texto simple'); });
  t.mock.method(fallbackModel, 'generateContent', async () => { calls.push('respaldo'); return resp(''); });
  const a = await analyzeDocument(foto, 'image/jpeg', 'image');
  assert.match(a, /^TIPO: CARTA/);
  assert.equal(calls.length, 2);
});

test('si las dos respuestas vienen vacías, devuelve null (el bot pide la foto otra vez)', async (t) => {
  let n = 0;
  t.mock.method(model, 'generateContent', async () => { n++; return resp('', 'SAFETY'); });
  t.mock.method(fallbackModel, 'generateContent', async () => { n++; return resp(''); });
  assert.equal(await analyzeDocument(foto, 'image/jpeg', 'image'), null);
  assert.equal(n, 2);
});
