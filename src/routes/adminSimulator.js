const express = require('express');
const { authenticate, requireRole } = require('../middleware/auth');
const SimulatorConversation = require('../models/SimulatorConversation');
const SimulatorMessage = require('../models/SimulatorMessage');

const router = express.Router();

// List all simulator conversations with message counts
router.get('/conversations', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { status, limit = 50, offset = 0 } = req.query;
    const conversations = await SimulatorConversation.findAllForAdmin({
      status,
      limit: parseInt(limit, 10),
      offset: parseInt(offset, 10),
    });
    res.json({ conversations });
  } catch (err) {
    console.error('[AdminSimulator] list error:', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// Get a single conversation with all messages
router.get('/conversations/:sessionId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const conversation = await SimulatorConversation.findBySession(req.params.sessionId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const messages = await SimulatorMessage.findByConversation(conversation.id);
    res.json({ conversation, messages });
  } catch (err) {
    console.error('[AdminSimulator] get error:', err);
    res.status(500).json({ error: 'Failed to get conversation' });
  }
});

// Update notes/status/title
router.put('/conversations/:sessionId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const conversation = await SimulatorConversation.findBySession(req.params.sessionId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const { notes, status, title } = req.body;
    const updated = await SimulatorConversation.updateNotes(conversation.id, { notes, status, title });
    res.json({ conversation: updated });
  } catch (err) {
    console.error('[AdminSimulator] update error:', err);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

module.exports = router;
