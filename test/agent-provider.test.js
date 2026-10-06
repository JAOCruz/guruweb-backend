const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeProvider, getProvider, setFakeProvider, isQuotaError } = require('../src/agent/provider');
const { toGeminiContents, toGeminiSchema } = require('../src/agent/provider/gemini');
const { toClaudeMessages } = require('../src/agent/provider/claude');

const convo = [
  { role: 'user', text: 'hola' },
  { role: 'assistant', toolCalls: [{ id: 'a', name: 'x', args: { q: 1 } }] },
  { role: 'tool', toolCallId: 'a', name: 'x', result: { ok: true } },
];

test('fake devuelve los pasos en orden y guarda lo que recibió', async () => {
  const p = createFakeProvider([{ toolCalls: [{ id: '1', name: 'buscar_servicio', args: { consulta: 'acto de venta' } }] }, { text: 'Listo' }]);
  assert.equal((await p.chat({ system: 's', messages: [], tools: [] })).toolCalls[0].name, 'buscar_servicio');
  assert.equal((await p.chat({ system: 's', messages: [], tools: [] })).text, 'Listo');
  assert.equal(p.calls.length, 2);
});

test('fake acepta funciones como paso y falla si se acaba el guion', async () => {
  const p = createFakeProvider([(m) => ({ text: `n=${m.length}` })]);
  assert.equal((await p.chat({ messages: [1, 2] })).text, 'n=2');
  await assert.rejects(() => p.chat({ messages: [] }));
});

test('setFakeProvider / getProvider("fake")', async () => {
  const p = createFakeProvider([{ text: 'x' }]);
  setFakeProvider(p);
  assert.equal(getProvider('fake'), p);
  assert.throws(() => getProvider('nope'));
});

test('gemini: toGeminiContents convierte una llamada y su resultado', () => {
  const c = toGeminiContents(convo);
  assert.deepEqual(c.map((m) => m.role), ['user', 'model', 'function']);
  assert.deepEqual(c[2].parts[0].functionResponse, { name: 'x', response: { ok: true } });
  assert.deepEqual(c[1].parts[0].functionCall, { name: 'x', args: { q: 1 } });
});

test('gemini: un resultado que no es un objeto plano se envuelve en { result }', () => {
  const mk = (result) => toGeminiContents([{ role: 'tool', toolCallId: 'a', name: 'x', result }])[0].parts[0].functionResponse.response;
  assert.deepEqual(mk([1, 2]), { result: [1, 2] });
  assert.deepEqual(mk('texto'), { result: 'texto' });
  assert.deepEqual(mk(null), { result: null });
  assert.deepEqual(mk({ ok: true }), { ok: true });
});

test('gemini: toGeminiSchema pone los tipos en mayúsculas, también los anidados', () => {
  assert.equal(toGeminiSchema({ type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } }).properties.a.items.type, 'STRING');
});

test('claude: toClaudeMessages agrupa el tool_result en un mensaje user', () => {
  const m = toClaudeMessages(convo);
  assert.deepEqual(m.map((x) => x.role), ['user', 'assistant', 'user']);
  assert.equal(m[2].content[0].type, 'tool_result');
  assert.equal(m[2].content[0].tool_use_id, 'a');
  assert.equal(m[1].content[0].type, 'tool_use');
});

test('isQuotaError reconoce 429 y RESOURCE_EXHAUSTED', () => {
  assert.equal(isQuotaError({ status: 429 }), true);
  assert.equal(isQuotaError(new Error('RESOURCE_EXHAUSTED: quota')), true);
  assert.equal(isQuotaError(new Error('timeout')), false);
});
