function toClaudeMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.text || '' });
    else if (m.role === 'assistant') {
      const content = [];
      if (m.text) content.push({ type: 'text', text: m.text });
      for (const tc of m.toolCalls || []) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args || {} });
      if (content.length) out.push({ role: 'assistant', content });
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: JSON.stringify(m.result) };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content[0].type === 'tool_result') last.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

async function chat({ system, messages, tools = [], timeoutMs }) {
  const { isQuotaError, withTimeout } = require('./index');
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic();
  try {
    const res = await withTimeout(client.messages.create({
      model: process.env.BOT_CLAUDE_MODEL || 'claude-sonnet-5-5',
      system,
      max_tokens: 1024,
      ...(tools.length ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })) } : {}),
      messages: toClaudeMessages(messages),
    }, { timeout: timeoutMs, maxRetries: 0 }), timeoutMs); // el ciclo del agente decide los reintentos
    const blocks = res.content || [];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text).join(''),
      toolCalls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input || {} })),
    };
  } catch (err) {
    if (err.code === 'TIMEOUT') throw err;
    if (isQuotaError(err)) { const e = new Error('Cuota agotada'); e.code = 'QUOTA'; throw e; }
    throw err;
  }
}

module.exports = { chat, toClaudeMessages };
