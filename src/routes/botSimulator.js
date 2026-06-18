const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticate, requireRole } = require('../middleware/auth');
const { routeMessage } = require('../conversation/router');
const { withList } = require('../whatsapp/interactive');
const { analyzeDocument, transcribeAudio } = require('../llm/mediaAnalysis');
const ClientMedia = require('../models/ClientMedia');
const SimulatorConversation = require('../models/SimulatorConversation');
const SimulatorMessage = require('../models/SimulatorMessage');
const config = require('../config');

const router = express.Router();

// Ensure base uploads directory exists
const UPLOADS_BASE = path.join(process.cwd(), 'uploads', 'simulator');
fs.mkdirSync(UPLOADS_BASE, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.body.sessionId || `sim_${Date.now().toString(36).slice(-8)}`;
    const dest = path.join(UPLOADS_BASE, sessionId);
    fs.mkdirSync(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const base = path.basename(file.originalname, ext).replace(/[^a-z0-9]/gi, '_').substring(0, 30);
    const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    cb(null, `${base}_${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    const allowedMimePrefixes = ['image/', 'audio/', 'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/plain'];
    const ok = allowedMimePrefixes.some(p => file.mimetype.startsWith(p) || file.mimetype === p);
    if (ok) return cb(null, true);
    cb(new Error(`Unsupported file type: ${file.mimetype}`));
  },
});

function detectMediaType(mimetype) {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * POST /api/bot/simulate
 * Simulates a WhatsApp conversation with the bot AI.
 * Accepts either JSON (text only) or multipart/form-data (text + file).
 */
router.post('/simulate', authenticate, requireRole('admin'), upload.single('file'), async (req, res) => {
  try {
    const { message, sessionId } = req.body;
    const file = req.file;

    if (!message && !file) {
      return res.status(400).json({ error: 'message or file is required' });
    }

    const phone = sessionId ? String(sessionId).trim() : `simulate_user_${req.user.id}`;
    console.log(`[BotSimulator] message from ${phone}: ${message?.substring(0, 80) || '[media only]'}`);
    console.log(`[BotSimulator] Gemini enabled: ${config.gemini.enabled}, key present: ${!!config.gemini.apiKey}`);

    // Persist conversation for this simulator session
    const conversation = await SimulatorConversation.findOrCreate(phone, req.user.id);

    let textMessage = message || '';
    let savedMedia = null;

    if (file) {
      const mediaType = detectMediaType(file.mimetype);
      console.log(`[BotSimulator] Received ${mediaType}: ${file.originalname} (${file.size} bytes)`);

      let analysis = null;
      if (mediaType === 'audio') {
        const transcription = await transcribeAudio(file.path, file.mimetype);
        if (transcription) {
          analysis = `TRANSCRIPCIÓN DE AUDIO:\n${transcription}`;
          // Use transcription as the message if no text was provided
          if (!textMessage.trim()) textMessage = transcription;
        }
      } else {
        analysis = await analyzeDocument(file.path, file.mimetype, mediaType);
      }

      // Persist media metadata for this simulator session
      const mediaRecord = await ClientMedia.create({
        phone,
        clientId: null,
        waMessageId: `sim_${Date.now()}`,
        mediaType,
        mimeType: file.mimetype,
        originalName: file.originalname,
        savedName: path.basename(file.path),
        filePath: file.path,
        fileSize: file.size,
        context: 'simulator',
      });

      savedMedia = {
        id: mediaRecord.id,
        analysis: analysis || `${mediaType.toUpperCase()}: ${file.originalname}`,
        filePath: file.path,
        mimeType: file.mimetype,
        mediaType,
        originalName: file.originalname,
      };

      console.log(`[BotSimulator] ${mediaType} analysis: ${(analysis || '').substring(0, 100)}...`);
    }

    // Save user message before routing
    await SimulatorMessage.create({
      conversationId: conversation.id,
      role: 'user',
      text: textMessage,
      mediaType: savedMedia?.mediaType,
      mediaOriginalName: savedMedia?.originalName,
      mediaAnalysis: savedMedia?.analysis,
    });

    // Route through the same logic used by the real WhatsApp bot.
    const response = await routeMessage(phone, textMessage, null, savedMedia);

    // withList returns an object when interactive lists are used; normalize to string for the UI.
    let text = '';
    if (typeof response === 'string') {
      text = response;
    } else if (response && typeof response === 'object') {
      text = response.text || response.body || JSON.stringify(response);
    }

    // Save bot response
    const botMessage = await SimulatorMessage.create({
      conversationId: conversation.id,
      role: 'bot',
      text,
    });

    res.json({
      phone,
      message: textMessage,
      response: text,
      botMessageId: botMessage.id,
      media: savedMedia
        ? {
            id: savedMedia.id,
            mediaType: savedMedia.mediaType,
            originalName: savedMedia.originalName,
            analysis: savedMedia.analysis,
          }
        : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[BotSimulator] Error:', err.message);
    res.status(500).json({ error: 'Simulation failed', detail: err.message });
  }
});

// Serve a simulator-uploaded file for preview/download
router.get('/simulate/file/:mediaId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const media = await ClientMedia.findById(req.params.mediaId);
    if (!media) return res.status(404).json({ error: 'File not found' });
    if (!media.file_path || !fs.existsSync(media.file_path)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }
    // Security: file must be within uploads directory
    const absPath = path.resolve(media.file_path);
    if (!absPath.startsWith(path.resolve(UPLOADS_BASE))) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.setHeader('Content-Type', media.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${media.original_name || media.saved_name}"`);
    res.sendFile(absPath);
  } catch (err) {
    console.error('[BotSimulator] File serve error:', err.message);
    res.status(500).json({ error: 'Failed to serve file' });
  }
});

// Diagnostic endpoint: check if Gemini is configured
router.get('/ai-status', authenticate, requireRole('admin'), (req, res) => {
  res.json({
    geminiEnabled: config.gemini.enabled,
    geminiKeyPresent: !!config.gemini.apiKey,
    geminiKeyPrefix: config.gemini.apiKey ? `${config.gemini.apiKey.slice(0, 8)}...` : null,
    nodeEnv: config.nodeEnv,
  });
});

// Get conversation history for the current simulator session
router.get('/simulate/conversation/:sessionId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const conversation = await SimulatorConversation.findBySession(req.params.sessionId);
    if (!conversation) return res.json({ conversation: null, messages: [] });
    const messages = await SimulatorMessage.findByConversation(conversation.id);
    res.json({ conversation, messages });
  } catch (err) {
    console.error('[BotSimulator] get conversation error:', err);
    res.status(500).json({ error: 'Failed to load conversation' });
  }
});

// Update simulator conversation notes/status/title
router.put('/simulate/conversation/:sessionId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const conversation = await SimulatorConversation.findBySession(req.params.sessionId);
    if (!conversation) return res.status(404).json({ error: 'Conversation not found' });

    const { notes, status, title } = req.body;
    const updated = await SimulatorConversation.updateNotes(conversation.id, { notes, status, title });
    res.json({ conversation: updated });
  } catch (err) {
    console.error('[BotSimulator] update conversation error:', err);
    res.status(500).json({ error: 'Failed to update conversation' });
  }
});

// Add feedback to a bot message
router.put('/simulate/feedback/:messageId', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const { feedback, rating } = req.body;
    const updated = await SimulatorMessage.updateFeedback(req.params.messageId, { feedback, rating });
    if (!updated) return res.status(404).json({ error: 'Message not found' });
    res.json({ message: updated });
  } catch (err) {
    console.error('[BotSimulator] feedback error:', err);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

module.exports = router;
