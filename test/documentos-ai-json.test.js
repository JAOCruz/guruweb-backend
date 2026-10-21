const test = require('node:test');
const assert = require('node:assert/strict');
const { jsonRequest } = require('../src/documentos/aiDocs');

// Documentos parses every Gemini answer as JSON; in free-text mode Gemini sometimes put a raw
// line break inside a string and the fill failed with "Bad control character in string literal".
const model = { generationConfig: { temperature: 0.75, maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 2048 } } };

test('asks Gemini for JSON and keeps the model settings', () => {
  const req = jsonRequest(model, 'Responde SOLO JSON');
  assert.equal(req.generationConfig.responseMimeType, 'application/json');
  assert.equal(req.generationConfig.maxOutputTokens, 16384);
  assert.deepEqual(req.generationConfig.thinkingConfig, { thinkingBudget: 2048 });
  assert.deepEqual(req.contents, [{ role: 'user', parts: [{ text: 'Responde SOLO JSON' }] }]);
});

test('keeps attachments (inlineData) next to the text', () => {
  const photo = { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } };
  const req = jsonRequest(model, ['Lee la cédula', photo]);
  assert.deepEqual(req.contents[0].parts, [{ text: 'Lee la cédula' }, photo]);
});

test('reads answers that copy raw tabs from the document into a string', () => {
  const { parseJson } = require('../src/documentos/aiDocs');
  const raw = '[\n  {"i": 19, "text": "______\t    ______\nfirma"}\n]';
  assert.deepEqual(parseJson(raw), [{ i: 19, text: '______\t    ______\nfirma' }]);
});
