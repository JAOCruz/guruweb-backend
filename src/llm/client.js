const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

// gemini-2.5 thinks before answering and those tokens count against maxOutputTokens: uncapped,
// the thinking used up 4096 and the JSON for Documentos (fields, fill, edits) came back cut off.
const GENERATION = {
  temperature: 0.75,
  maxOutputTokens: 16384,
  topP: 0.9,
  thinkingConfig: { thinkingBudget: 2048 },
};

// Primary: gemini-2.5-flash (current stable, fast, good quota)
// NOTE: gemini-1.5-* was retired by Google (Sep 2025) and now 404s.
const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  generationConfig: GENERATION,
});

// Fallback: gemini-flash-latest (always points at the newest stable flash)
const fallbackModel = genAI.getGenerativeModel({
  model: 'gemini-flash-latest',
  generationConfig: GENERATION,
});

module.exports = { model, fallbackModel };
