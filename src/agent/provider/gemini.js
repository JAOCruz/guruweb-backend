const { GoogleGenerativeAI } = require('@google/generative-ai');

function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties' || k === '$schema') continue;
    if (k === 'type' && typeof v === 'string') out.type = v.toUpperCase();
    else if (k === 'properties') {
      out.properties = {};
      for (const [pk, pv] of Object.entries(v)) out.properties[pk] = toGeminiSchema(pv);
    } else out[k] = toGeminiSchema(v);
  }
  return out;
}

function toGeminiContents(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', parts: [{ text: m.text || '' }] });
    else if (m.role === 'assistant') {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const tc of m.toolCalls || []) parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
      if (parts.length) out.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      const part = { functionResponse: { name: m.name, response: m.result } };
      const last = out[out.length - 1];
      if (last && last.role === 'function') last.parts.push(part);
      else out.push({ role: 'function', parts: [part] });
    }
  }
  return out;
}

async function chat({ system, messages, tools = [], timeoutMs }) {
  const { isQuotaError, withTimeout } = require('./index');
  const apiKey = require('../../config').gemini.apiKey;
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: system,
    ...(tools.length ? { tools: [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }] } : {}),
    generationConfig: { temperature: 0.4 },
  });
  try {
    const result = await withTimeout(model.generateContent({ contents: toGeminiContents(messages) }), timeoutMs);
    const response = result.response;
    const calls = response.functionCalls() || [];
    let text = '';
    try { text = calls.length ? '' : response.text(); } catch { text = ''; }
    return { text, toolCalls: calls.map((c, i) => ({ id: `${c.name}-${i}`, name: c.name, args: c.args || {} })) };
  } catch (err) {
    if (err.code === 'TIMEOUT') throw err;
    if (isQuotaError(err)) { const e = new Error('Cuota agotada'); e.code = 'QUOTA'; throw e; }
    throw err;
  }
}

module.exports = { chat, toGeminiContents, toGeminiSchema };
