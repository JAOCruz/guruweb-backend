const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

// Primary: gemini-2.5-flash (current stable, fast, good quota)
// NOTE: gemini-1.5-* was retired by Google (Sep 2025) and now 404s.
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: {
    temperature: 0.75,
    maxOutputTokens: 4096,
    topP: 0.9,
  },
});

// Fallback: gemini-flash-latest (always points at the newest stable flash)
const fallbackModel = genAI.getGenerativeModel({
  model: 'gemini-flash-latest',
  generationConfig: {
    temperature: 0.75,
    maxOutputTokens: 4096,
    topP: 0.9,
  },
});

module.exports = { model, fallbackModel };
