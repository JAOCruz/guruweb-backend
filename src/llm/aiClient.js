const config = require('../config');

/**
 * Call AI (Gemini or MiniMax) for text generation
 * Falls back to MiniMax if Gemini fails due to quota
 */
async function callAI(prompt) {
  // Try Gemini first if enabled
  if (config.gemini.enabled) {
    try {
      const { GoogleGenerativeAI } = require('@google/generative-ai');
      const genAI = new GoogleGenerativeAI(config.gemini.apiKey);
      const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
      const response = await model.generateContent(prompt);
      return response.response.text();
    } catch (err) {
      if (err.message?.includes('429') || err.message?.includes('quota')) {
        console.log('[AI] Gemini quota exceeded, falling back to MiniMax');
      } else {
        console.error('[AI] Gemini error:', err.message);
        // Fall through to MiniMax
      }
    }
  }

  // Try MiniMax as fallback or primary
  if (config.minimax.enabled) {
    try {
      const response = await callMiniMax(prompt);
      return response;
    } catch (err) {
      console.error('[AI] MiniMax error:', err.message);
      throw err;
    }
  }

  throw new Error('No AI provider available');
}

/**
 * Call MiniMax API
 */
async function callMiniMax(prompt) {
  const fetch = (await import('node-fetch')).default;

  const response = await fetch('https://api.minimaxi.chat/v1/text/chatcompletion', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.minimax.apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
      stream: false,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`MiniMax API error: ${response.status} ${error}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

module.exports = { callAI, callMiniMax };
