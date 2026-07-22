const express = require('express');
const path = require('path');
const multer = require('multer');
const Message = require('../models/Message');
const ClientMedia = require('../models/ClientMedia');
const storage = require('../utils/storage');
const { sendMessage, getAnyConnection } = require('../whatsapp/connection');
const Client = require('../models/Client');
const { authenticate, requireRole } = require('../middleware/auth');

const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB (WhatsApp media cap)
});

function isEmployee(role) {
  return role !== 'admin';
}
const {
  setChatEnabled, isChatEnabled, getEnabledPhones,
  setManualMode, isManualMode, getManualPhones,
  shouldBotRespond,
} = require('../whatsapp/handler');

const router = express.Router();

// Internal endpoint to toggle manual mode (requires auth)
router.post('/internal/manual-toggle/:phone', authenticate, (req, res) => {
  const phone = req.params.phone;
  const current = isManualMode(phone);
  setManualMode(phone, !current);
  res.json({ phone, manualMode: !current, botResponding: shouldBotRespond(phone) });
});

router.use(authenticate);

// Get all conversations grouped by phone number
// Admin sees everything; employees (digitador/auxiliar) only see assigned clients/cases.
router.get('/conversations', async (req, res) => {
  try {
    const filter = req.query.filter || 'all'; // all | clients | non_clients
    const userId = isEmployee(req.user.role) ? req.user.id : null;
    const conversations = await Message.getConversations(filter, userId);
    // Enrich with bot/manual state
    for (const conv of conversations) {
      conv.chatEnabled = isChatEnabled(conv.phone);
      conv.botActive = !isManualMode(conv.phone);
      conv.manualMode = isManualMode(conv.phone);
    }
    res.json({ conversations });
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// Get messages by phone number
router.get('/phone/:phone', async (req, res) => {
  try {
    const { limit, offset } = req.query;
    const messages = await Message.findByPhone(req.params.phone, {
      limit: parseInt(limit, 10) || 100,
      offset: parseInt(offset, 10) || 0,
    });
    res.json({ messages });
  } catch (err) {
    console.error('List messages by phone error:', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

router.get('/client/:clientId', async (req, res) => {
  try {
    const { limit, offset } = req.query;
    const messages = await Message.findByClient(req.params.clientId, {
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0,
    });
    res.json({ messages });
  } catch (err) {
    console.error('List messages error:', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

router.get('/case/:caseId', async (req, res) => {
  try {
    const { limit, offset } = req.query;
    const messages = await Message.findByCase(req.params.caseId, {
      limit: parseInt(limit, 10) || 50,
      offset: parseInt(offset, 10) || 0,
    });
    res.json({ messages });
  } catch (err) {
    console.error('List messages error:', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

router.post('/send', async (req, res) => {
  try {
    const { client_id, case_id, content, session_id } = req.body;
    if (!client_id || !content || !session_id) {
      return res.status(400).json({ error: 'client_id, content, and session_id are required' });
    }

    const client = await Client.findById(client_id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    const jid = `${client.phone}@s.whatsapp.net`;
    const sent = await sendMessage(session_id, jid, { text: content });

    const message = await Message.create({
      waMessageId: sent.key.id,
      phone: client.phone,
      clientId: client_id,
      caseId: case_id || null,
      direction: 'outbound',
      content,
    });

    res.status(201).json({ message });
  } catch (err) {
    console.error('Send message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Send a message directly by phone number (for agent replies from Messages page)
router.post('/send-direct', async (req, res) => {
  try {
    const { phone, content } = req.body;
    if (!phone || !content) {
      return res.status(400).json({ error: 'phone and content are required' });
    }

    const conn = getAnyConnection();
    if (!conn) {
      return res.status(503).json({ error: 'No hay sesion de WhatsApp conectada' });
    }

    // Use the real JID from last inbound message (handles @lid privacy accounts)
    const lastJid = await Message.getLastJid(phone);
    const jid = lastJid || `${phone}@s.whatsapp.net`;
    const sent = await sendMessage(conn.sessionId, jid, { text: content });

    // Find client_id if this phone is a registered client
    const client = await Client.findByPhone(phone);

    const message = await Message.create({
      waMessageId: sent.key.id,
      phone,
      clientId: client?.id || null,
      caseId: null,
      direction: 'outbound',
      content,
      waJid: jid,
    });

    res.status(201).json({ message });
  } catch (err) {
    console.error('Send direct message error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// Send a media file (image/audio/video/document) to a chat by phone number.
// Used by employees in manual mode to send files from the dashboard chat.
// multipart/form-data: fields phone, caption? + file
router.post('/send-media', uploadMedia.single('file'), async (req, res) => {
  try {
    const { phone, caption } = req.body;
    const file = req.file;
    if (!phone || !file) {
      return res.status(400).json({ error: 'phone and file are required' });
    }

    const conn = getAnyConnection();
    if (!conn) {
      return res.status(503).json({ error: 'No hay sesion de WhatsApp conectada' });
    }

    // Resolve real JID (handles @lid privacy accounts)
    const lastJid = await Message.getLastJid(phone);
    const jid = lastJid || `${phone}@s.whatsapp.net`;

    // Persist file to the Railway volume so it shows in the media viewer
    const timestamp = Date.now();
    const ext = path.extname(file.originalname || '') || '';
    const savedName = `${timestamp}_out${ext}`;
    const filePath = storage.saveBuffer(file.buffer, `media/${phone}`, savedName);

    const mime = file.mimetype || 'application/octet-stream';
    const isImage = mime.startsWith('image/');
    const isAudio = mime.startsWith('audio/');
    const isVideo = mime.startsWith('video/');
    const mediaType = isImage ? 'image' : isAudio ? 'audio' : isVideo ? 'video' : 'document';

    // Send via WhatsApp
    let sent;
    if (isImage) {
      sent = await conn.sock.sendMessage(jid, { image: file.buffer, caption: caption || '' });
    } else if (isVideo) {
      sent = await conn.sock.sendMessage(jid, { video: file.buffer, caption: caption || '' });
    } else if (isAudio) {
      sent = await conn.sock.sendMessage(jid, { audio: file.buffer, mimetype: mime, ptt: false });
    } else {
      sent = await conn.sock.sendMessage(jid, { document: file.buffer, fileName: file.originalname, mimetype: mime, caption: caption || '' });
    }

    const client = await Client.findByPhone(phone);

    // Register media so it appears in the dashboard media viewer
    const mediaRecord = await ClientMedia.create({
      phone,
      clientId: client?.id || null,
      waMessageId: sent.key.id,
      mediaType,
      mimeType: mime,
      originalName: file.originalname,
      savedName,
      filePath,
      fileSize: file.size,
      context: 'conversation',
    });

    const typeLabel = mediaType === 'image' ? 'imagen' : mediaType === 'audio' ? 'audio' : mediaType === 'video' ? 'video' : 'adjunto';
    const content = caption?.trim()
      ? `${caption.trim()}\n[📎 ${typeLabel}]`
      : `[📎 ${typeLabel}]`;

    const message = await Message.create({
      waMessageId: sent.key.id,
      phone,
      clientId: client?.id || null,
      caseId: null,
      direction: 'outbound',
      content,
      mediaUrl: `/api/media/${mediaRecord.id}/download`,
      waJid: jid,
    });

    console.log(`[Messages] Media sent to ${phone}: ${mediaType} (${(file.size / 1024).toFixed(1)}KB) by ${req.user.username}`);
    res.status(201).json({ message, media: mediaRecord });
  } catch (err) {
    console.error('Send media error:', err);
    res.status(500).json({ error: 'Failed to send media: ' + err.message });
  }
});

// Toggle chat enabled (for "selected" mode — activate/deactivate bot for a chat)
router.post('/chat-toggle/:phone', (req, res) => {
  const { phone } = req.params;
  const current = isChatEnabled(phone);
  setChatEnabled(phone, !current);
  res.json({ phone, chatEnabled: !current, botResponding: shouldBotRespond(phone) });
});

// Toggle manual mode (agent takeover — independent of chat enabled)
router.post('/manual-toggle/:phone', (req, res) => {
  const { phone } = req.params;
  const current = isManualMode(phone);
  setManualMode(phone, !current);
  res.json({ phone, manualMode: !current, botResponding: shouldBotRespond(phone) });
});

// Get full status for a phone number
router.get('/phone-status/:phone', (req, res) => {
  const phone = req.params.phone;
  res.json({
    phone,
    chatEnabled: isChatEnabled(phone),
    manualMode: isManualMode(phone),
    botResponding: shouldBotRespond(phone),
  });
});

// Get all enabled phones (selected mode)
router.get('/enabled-phones', (req, res) => {
  res.json({ phones: getEnabledPhones() });
});

// Get all manual phones
router.get('/manual-phones', (req, res) => {
  res.json({ phones: getManualPhones() });
});

// Register a phone number as a client manually from the Messages page
router.post('/register-client', async (req, res) => {
  try {
    const { phone, name, email, address, notes } = req.body;
    if (!phone || !name) {
      return res.status(400).json({ error: 'phone and name are required' });
    }

    // Check if client already exists
    const existing = await Client.findByPhone(phone);
    if (existing) {
      return res.status(409).json({ error: 'Este número ya está registrado como cliente', client: existing });
    }

    const client = await Client.create({
      name,
      phone,
      email: email || null,
      address: address || null,
      notes: notes || null,
      userId: req.user.id,
    });

    // Backfill client_id on existing messages for this phone
    const pool = require('../db/pool');
    await pool.query(
      'UPDATE messages SET client_id = $1 WHERE phone = $2 AND client_id IS NULL',
      [client.id, phone]
    );

    res.status(201).json({ client });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Este número ya está registrado' });
    }
    console.error('Register client error:', err);
    res.status(500).json({ error: 'Failed to register client' });
  }
});

// Search conversations by message content
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Search query too short (minimum 2 chars)' });
    }

    const conversations = await Message.searchByContent(q);
    // Enrich with bot/manual state
    for (const conv of conversations) {
      conv.chatEnabled = isChatEnabled(conv.phone);
      conv.botActive = !isManualMode(conv.phone);
      conv.manualMode = isManualMode(conv.phone);
    }

    res.json({ conversations });
  } catch (err) {
    console.error('Search messages error:', err);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

module.exports = router;
