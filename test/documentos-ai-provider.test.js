const test = require('node:test');
const assert = require('node:assert/strict');
const { claudeContent, routeGenerate, docsProvider } = require('../src/documentos/aiDocs');

const photo = { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } };
const pdf = { inlineData: { mimeType: 'application/pdf', data: 'BBBB' } };
const audio = { inlineData: { mimeType: 'audio/ogg', data: 'CCCC' } };
const heic = { inlineData: { mimeType: 'image/heic', data: 'DDDD' } };

test('turns text, photos and PDFs into Claude content blocks', () => {
  assert.deepEqual(claudeContent(['Lee la cédula', photo, pdf]), [
    { type: 'text', text: 'Lee la cédula' },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } },
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'BBBB' } },
  ]);
  assert.deepEqual(claudeContent('Solo texto'), [{ type: 'text', text: 'Solo texto' }]);
});

test('Claude cannot read audios or HEIC photos: no Claude content', () => {
  assert.equal(claudeContent(['Escucha', audio]), null);
  assert.equal(claudeContent(['Mira', heic]), null);
});

test('uses Claude when it is the provider', async () => {
  const calls = [];
  const out = await routeGenerate(['hola', photo], {
    provider: 'claude',
    claude: async (content) => { calls.push(['claude', content.length]); return '{"a":1}'; },
    gemini: async () => { calls.push(['gemini']); return '{}'; },
  });
  assert.equal(out, '{"a":1}');
  assert.deepEqual(calls, [['claude', 2]]);
});

test('falls back to Gemini when Claude fails', async () => {
  const out = await routeGenerate('hola', {
    provider: 'claude',
    claude: async () => { throw new Error('overloaded'); },
    gemini: async (parts) => `gemini:${parts}`,
    log: () => {},
  });
  assert.equal(out, 'gemini:hola');
});

test('audios go straight to Gemini', async () => {
  let claudeCalled = false;
  const out = await routeGenerate(['escucha', audio], {
    provider: 'claude',
    claude: async () => { claudeCalled = true; return ''; },
    gemini: async () => 'gemini',
  });
  assert.equal(out, 'gemini');
  assert.equal(claudeCalled, false);
});

test('provider: DOCS_AI_PROVIDER wins, else Claude when there is an Anthropic key', () => {
  assert.equal(docsProvider({ DOCS_AI_PROVIDER: 'gemini', ANTHROPIC_API_KEY: 'x' }), 'gemini');
  assert.equal(docsProvider({ ANTHROPIC_API_KEY: 'x' }), 'claude');
  assert.equal(docsProvider({}), 'gemini');
});
