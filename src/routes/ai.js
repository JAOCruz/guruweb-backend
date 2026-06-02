const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { model, fallbackModel } = require('../llm/client');
const config = require('../config');

// POST /api/ai/generate — generic Gemini proxy
// Keeps API key server-side; frontend sends prompt + systemPrompt
router.post('/generate', authenticate, async (req, res) => {
  try {
    if (!config.gemini.enabled || !config.gemini.apiKey) {
      return res.status(503).json({ error: 'AI service not configured. Set GEMINI_API_KEY in backend .env' });
    }

    const { prompt, systemPrompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    };

    if (systemPrompt) {
      payload.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    let result;
    try {
      result = await model.generateContent(payload);
    } catch (primaryErr) {
      // Fallback model on retriable errors
      const msg = primaryErr.message || '';
      const retriable = ['429', '500', '503', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL'];
      if (retriable.some(code => msg.includes(code))) {
        result = await fallbackModel.generateContent(payload);
      } else {
        throw primaryErr;
      }
    }

    const text = result?.response?.text?.() || '';
    res.json({ text });
  } catch (err) {
    console.error('[AI] Generation error:', err.message);
    res.status(500).json({ error: 'AI generation failed', detail: err.message });
  }
});

module.exports = router;
