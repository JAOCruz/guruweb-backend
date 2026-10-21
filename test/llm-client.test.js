require('./helpers/db'); // test env (JWT_SECRET…) before loading the config
const test = require('node:test');
const assert = require('node:assert/strict');
const { model, fallbackModel } = require('../src/llm/client');

// gemini-2.5 "thinks" before answering and those tokens count against maxOutputTokens: with
// 4096 and no cap, the thinking used ~3900 and the JSON for Documentos came back cut off.
for (const [name, m] of [['model', model], ['fallbackModel', fallbackModel]]) {
  test(`${name} leaves room for the answer after thinking`, () => {
    const { maxOutputTokens, thinkingConfig } = m.generationConfig;
    assert.ok(thinkingConfig && thinkingConfig.thinkingBudget >= 0, 'thinking must be capped');
    assert.ok(maxOutputTokens - thinkingConfig.thinkingBudget >= 8192, 'at least 8192 tokens left for the answer');
  });
}
