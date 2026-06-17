const express = require('express');
const { authenticate } = require('../middleware/auth');
const { routeMessage } = require('../conversation/router');
const { withList } = require('../whatsapp/interactive');

const router = express.Router();

/**
 * POST /api/bot/simulate
 * Simulates a WhatsApp conversation with the bot AI.
 * No real WhatsApp connection is needed.
 *
 * Body:
 *   - message: string (required) - the text the user sends
 *   - sessionId: string (optional) - unique test session id/phone. Defaults to the authenticated user's id.
 */
router.post('/simulate', authenticate, async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }

    // Use a deterministic test phone per user so the session persists across requests.
    const phone = sessionId ? String(sessionId).trim() : `simulate_user_${req.user.id}`;

    console.log(`[BotSimulator] message from ${phone}: ${message.substring(0, 80)}`);

    // Route through the same logic used by the real WhatsApp bot.
    const response = await routeMessage(phone, message, null, null);

    // withList returns an object when interactive lists are used; normalize to string for the UI.
    let text = '';
    if (typeof response === 'string') {
      text = response;
    } else if (response && typeof response === 'object') {
      text = response.text || response.body || JSON.stringify(response);
    }

    res.json({
      phone,
      message,
      response: text,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[BotSimulator] Error:', err.message);
    res.status(500).json({ error: 'Simulation failed', detail: err.message });
  }
});

module.exports = router;
