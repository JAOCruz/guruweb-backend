// Jay, 2026-11-25: las fotos y los PDF los lee Claude (la cuota gratuita de Gemini se agotaba a media prueba);
// Gemini queda de respaldo si Claude falla, y para lo que Claude no lee (audios, otros archivos).
require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { model, fallbackModel } = require('../src/llm/client');
const media = require('../src/llm/mediaAnalysis');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-'));
const foto = path.join(dir, 'f.jpg'); fs.writeFileSync(foto, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
const pdf = path.join(dir, 'd.pdf'); fs.writeFileSync(pdf, Buffer.from('%PDF-1.4\n%%EOF'));
const gem = (text) => ({ response: { text: () => text, candidates: [{ finishReason: 'STOP' }] } });

function fakeClaude(reply) {
  const calls = [];
  return { calls, messages: { create: async (req) => { calls.push(req); if (reply instanceof Error) throw reply; return reply; } } };
}
const ok = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] });

test.beforeEach(() => { process.env.ANTHROPIC_API_KEY = 'test'; delete process.env.BOT_CLAUDE_MODEL; });
test.afterEach(() => { media._setClaudeClient(null); delete process.env.ANTHROPIC_API_KEY; });

test('una foto la lee Claude (imagen en base64) y no se llama a Gemini', async (t) => {
  const c = fakeClaude(ok('TIPO: CARTA\nEXTENSION: 1 página, texto simple'));
  media._setClaudeClient(c);
  const g = t.mock.method(model, 'generateContent', async () => gem('no'));
  const a = await media.analyzeDocument(foto, 'image/jpeg', 'image');
  assert.match(a, /^TIPO: CARTA/);
  assert.equal(g.mock.callCount(), 0);
  const req = c.calls[0];
  assert.equal(req.model, 'claude-sonnet-5-5');
  const [bloque, texto] = req.messages[0].content;
  assert.deepEqual(bloque, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: fs.readFileSync(foto).toString('base64') } });
  assert.equal(texto.type, 'text');
  assert.match(texto.text, /TIPO:/);
});

test('un PDF va como documento', async () => {
  const c = fakeClaude(ok('TIPO: ACTA\nEXTENSION: 4 páginas, texto denso'));
  media._setClaudeClient(c);
  await media.analyzeDocument(pdf, 'application/pdf', 'document');
  assert.equal(c.calls[0].messages[0].content[0].type, 'document');
  assert.equal(c.calls[0].messages[0].content[0].source.media_type, 'application/pdf');
});

test('si Claude falla, la lee Gemini', async (t) => {
  media._setClaudeClient(fakeClaude(Object.assign(new Error('overloaded'), { status: 529 })));
  t.mock.method(model, 'generateContent', async () => gem('TIPO: CÉDULA\nEXTENSION: 1 página, texto simple'));
  assert.match(await media.analyzeDocument(foto, 'image/jpeg', 'image'), /^TIPO: CÉDULA/);
});

test('si Claude se niega o responde vacío, la lee Gemini', async (t) => {
  media._setClaudeClient(fakeClaude({ stop_reason: 'refusal', content: [] }));
  t.mock.method(model, 'generateContent', async () => gem('TIPO: OTRO\nEXTENSION: 1 página'));
  assert.match(await media.analyzeDocument(foto, 'image/jpeg', 'image'), /^TIPO: OTRO/);
});

test('sin clave de Claude, todo sigue con Gemini', async (t) => {
  delete process.env.ANTHROPIC_API_KEY;
  const c = fakeClaude(ok('no'));
  media._setClaudeClient(c);
  t.mock.method(model, 'generateContent', async () => gem('TIPO: RECIBO\nEXTENSION: 1 página'));
  assert.match(await media.analyzeDocument(foto, 'image/jpeg', 'image'), /^TIPO: RECIBO/);
  assert.equal(c.calls.length, 0);
});

test('un archivo que Claude no lee (Word) va directo a Gemini', async (t) => {
  const c = fakeClaude(ok('no'));
  media._setClaudeClient(c);
  t.mock.method(model, 'generateContent', async () => gem('TIPO: CONTRATO\nEXTENSION: 2 páginas'));
  t.mock.method(fallbackModel, 'generateContent', async () => gem(''));
  const doc = path.join(dir, 'x.docx'); fs.writeFileSync(doc, 'x');
  await media.analyzeDocument(doc, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'document');
  assert.equal(c.calls.length, 0);
});
