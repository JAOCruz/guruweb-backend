const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

// Primary: gemini-2.5-flash (confirmed working with this API key)
// Note: 2.5-flash is a "thinking" model — internal reasoning tokens count against
// maxOutputTokens, so we need a high budget (8192) to avoid truncated responses.
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: {
    temperature: 0.75,
    maxOutputTokens: 8192,
    topP: 0.9,
  },
});

// Fallback: gemini-2.5-flash-lite (also confirmed working)
const fallbackModel = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash-lite',
  generationConfig: {
    temperature: 0.75,
    maxOutputTokens: 8192,
    topP: 0.9,
  },
});

module.exports = { model, fallbackModel };
