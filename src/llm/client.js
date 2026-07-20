const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../config');

const genAI = new GoogleGenerativeAI(config.gemini.apiKey);

// Primary: gemini-1.5-flash (stable, fast, good quota)
const model = genAI.getGenerativeModel({
  model: 'gemini-1.5-flash',
  generationConfig: {
    temperature: 0.75,
    maxOutputTokens: 4096,
    topP: 0.9,
  },
});

// Fallback: gemini-1.5-pro (higher quality if flash fails/hits quota)
const fallbackModel = genAI.getGenerativeModel({
  model: 'gemini-1.5-pro',
  generationConfig: {
    temperature: 0.75,
    maxOutputTokens: 4096,
    topP: 0.9,
  },
});

module.exports = { model, fallbackModel };
