const express = require('express');
const path = require('path');
const multer = require('multer');
const Message = require('../models/Message');
const ClientMedia = require('../models/ClientMedia');
const storage = require('../utils/storage');
const Client = require('../models/Client');
const outgoing = require('../whatsapp/outgoing');
const { authenticate, requireRole } = require('../middleware/auth');

const uploadMedia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 }, // 16MB (WhatsApp media cap)
});

// Si WhatsApp no acepta el mensaje, el panel tiene que saberlo y nada queda guardado como enviado
const WINDOW_TEXT = 'No se envió: pasaron más de 24 h desde el último mensaje del cliente. '
  + 'WhatsApp solo deja escribirle cuando el cliente vuelva a escribir.';
async function trySend(res, send) {
  try {
    return await send();
  } catch (err) {
    console.error('[Messages] send failed:', err.code || err.metaCode || err.name || 'ERROR');
    if (err.code === 'WINDOW_CLOSED') res.status(409).json({ error: WINDOW_TEXT, code: 'WINDOW_CLOSED' });
    else res.status(502).json({ error: 'No se envió: WhatsApp no aceptó el mensaje. Inténtalo de nuevo.', code: 'SEND_FAILED' });
    return null;
  }
}

function isEmployee(role) {
  return role !== 'admin';
}
const {
  setChatEnabled, isChatEnabled, getEnabledPhones,
  setManualMode, isManualMode, getManualPhones,
  shouldBotRespond, chatBotOn, toggleChatBot,
} = require('../whatsapp/handler');

const { getChatsSince } = require('../whatsapp/botSettings');

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
    const hidden = req.query.hidden === '1';
    if (hidden && req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el administrador ve los chats ocultos' });
    const conversations = await Message.getConversations(filter, userId, await getChatsSince(), { hidden });
    // Enrich with bot/manual state
    for (const conv of conversations) {
      if (hidden) conv.hidden = true;
      conv.chatEnabled = isChatEnabled(conv.phone);
      conv.botActive = chatBotOn(conv.phone);
      conv.manualMode = isManualMode(conv.phone);
    }
    res.json({ conversations });
  } catch (err) {
    console.error('List conversations error:', err);
    res.status(500).json({ error: 'Failed to list conversations' });
  }
});

// Count unread inbound messages (drives the "Mensajes" badge).
// Admin sees all; an employee only counts chats assigned to them.
router.get('/unread-count', async (req, res) => {
  try {
    const pool = require('../db/pool');
    // chats archived with «Empezar de cero» are not in the list, so they do not count either
    const since = (await getChatsSince()) || '-infinity';
    let result;
    if (isEmployee(req.user.role)) {
      result = await pool.query(
        `SELECT COUNT(*) AS count FROM messages m
         WHERE m.read = FALSE AND m.direction = 'inbound' AND m.created_at >= $2
           AND NOT EXISTS (SELECT 1 FROM hidden_chats h WHERE h.phone = m.phone AND m.created_at <= h.hidden_at)
           AND (
             m.phone IN (SELECT phone FROM clients WHERE assigned_to = $1)
             OR m.client_id IN (SELECT id FROM clients WHERE assigned_to = $1)
             OR m.case_id IN (SELECT id FROM cases WHERE user_id = $1)
           )`,
        [req.user.id, since]
      );
    } else {
      result = await pool.query(
        `SELECT COUNT(*) AS count FROM messages m WHERE m.read = FALSE AND m.direction = 'inbound' AND m.created_at >= $1 AND NOT EXISTS (SELECT 1 FROM hidden_chats h WHERE h.phone = m.phone AND m.created_at <= h.hidden_at)`, [since]
      );
    }
    res.json({ count: parseInt(result.rows[0].count, 10) || 0 });
  } catch (err) {
    console.error('Unread count error:', err);
    res.status(500).json({ error: 'Failed to count unread messages' });
  }
});

// Mark all inbound messages of a chat as read (called when the chat is opened).
router.post('/phone/:phone/mark-read', async (req, res) => {
  try {
    const pool = require('../db/pool');
    const phone = req.params.phone;
    const { rowCount } = await pool.query(
      `UPDATE messages SET read = TRUE
       WHERE read = FALSE AND direction = 'inbound'
         AND (phone = $1 OR (phone IS NULL AND client_id IN (SELECT id FROM clients WHERE phone = $1)))`,
      [phone]
    );
    res.json({ marked: rowCount });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// Herramientas que el agente usó para cada respuesta del bot (bot_tool_log.message_id), en una sola
// consulta. Solo los mensajes outbound llevan `tools` (vacío si no usó ninguna o si la respuesta no fue
// del agente); los inbound no cambian: el panel ya los pinta y no tienen herramientas.
async function attachTools(messages) {
  const outbound = messages.filter((m) => m.direction === 'outbound');
  if (!outbound.length) return messages;
  const pool = require('../db/pool');
  const { rows } = await pool.query(
    `SELECT message_id, herramienta, ok FROM bot_tool_log WHERE message_id = ANY($1::int[]) ORDER BY id`,
    [outbound.map((m) => m.id)]
  );
  const byMessage = new Map();
  for (const r of rows) {
    if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, []);
    byMessage.get(r.message_id).push({ herramienta: r.herramienta, ok: r.ok });
  }
  for (const m of outbound) m.tools = byMessage.get(m.id) || [];
  return messages;
}

// Get messages by phone number
router.get('/phone/:phone', async (req, res) => {
  try {
    const { limit, offset } = req.query;
    const messages = await Message.findByPhone(req.params.phone, {
      limit: parseInt(limit, 10) || 100,
      offset: parseInt(offset, 10) || 0,
      onlyVisible: !(req.user.role === 'admin' && req.query.hidden === '1'),
    });
    // Las herramientas son un extra: si bot_tool_log no existe (migración sin correr) el chat se lista igual.
    try {
      await attachTools(messages);
    } catch (err) {
      console.error('List messages: could not attach bot tools:', err.code || err.name || 'error');
      for (const m of messages) if (m.direction === 'outbound') m.tools = [];
    }
    res.json({ messages });
  } catch (err) {
    console.error('List messages by phone error:', err);
    res.status(500).json({ error: 'Failed to list messages' });
  }
});

// Ocultar o volver a mostrar un chat (solo admin). No se borra nada.
router.post('/phone/:phone/hide', requireRole('admin'), async (req, res) => {
  try {
    await Message.hideChat(req.params.phone, req.user.id);
    res.json({ hidden: true });
  } catch (err) {
    console.error('Hide chat error:', err.code || err.name || 'ERROR');
    res.status(500).json({ error: 'No se pudo ocultar el chat' });
  }
});

router.post('/phone/:phone/unhide', requireRole('admin'), async (req, res) => {
  try {
    await Message.unhideChat(req.params.phone);
    res.json({ hidden: false });
  } catch (err) {
    console.error('Unhide chat error:', err.code || err.name || 'ERROR');
    res.status(500).json({ error: 'No se pudo mostrar el chat' });
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

    const sent = await trySend(res, () => outgoing.sendText(client.phone, content));
    if (!sent) return;

    const message = await Message.create({
      waMessageId: sent.key?.id || null,
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

    if (!outgoing.isAvailable()) {
      return res.status(503).json({ error: 'No hay sesión de WhatsApp conectada' });
    }

    // Use the real JID from last inbound message (handles @lid privacy accounts)
    const lastJid = await Message.getLastJid(phone);
    const target = lastJid || phone;
    const sent = await trySend(res, () => outgoing.sendText(target, content));
    if (!sent) return;

    // Find client_id if this phone is a registered client
    const client = await Client.findByPhone(phone);

    const message = await Message.create({
      waMessageId: sent.key?.id || null,
      phone,
      clientId: client?.id || null,
      caseId: null,
      direction: 'outbound',
      content,
      waJid: target,
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

    if (!outgoing.isAvailable()) {
      return res.status(503).json({ error: 'No hay sesión de WhatsApp conectada' });
    }

    // Resolve real JID (handles @lid privacy accounts)
    const lastJid = await Message.getLastJid(phone);
    const target = lastJid || phone;

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

    // Send via the unified outgoing layer (Cloud API or Baileys)
    const sent = await trySend(res, () => outgoing.sendMedia(target, filePath, {
      mime,
      fileName: file.originalname,
      caption: caption || '',
      mediaType,
    }));
    if (!sent) return;

    const client = await Client.findByPhone(phone);

    // Register media so it appears in the dashboard media viewer
    const mediaRecord = await ClientMedia.create({
      phone,
      clientId: client?.id || null,
      waMessageId: sent.key?.id || null,
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
      waMessageId: sent.key?.id || null,
      phone,
      clientId: client?.id || null,
      caseId: null,
      direction: 'outbound',
      content,
      mediaUrl: `/api/media/${mediaRecord.id}/download`,
      waJid: target,
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

// The chat's 🤖 button: in "Seleccionados" turns the bot on/off for this chat, in "Todos" is the agent takeover
router.post('/bot-toggle/:phone', (req, res) => {
  const { phone } = req.params;
  const botActive = toggleChatBot(phone);
  res.json({ phone, botActive, botResponding: shouldBotRespond(phone) });
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

// Map a privacy @lid chat to a real phone number (admin). Moves all its messages to
// the real phone, unifying the conversation. Since those messages carry wa_jid=<lid>,
// future messages from that @lid resolve to the real phone automatically.
router.post('/map-lid', requireRole('admin'), async (req, res) => {
  try {
    const { lidPhone, realPhone } = req.body;
    if (!lidPhone || !realPhone) {
      return res.status(400).json({ error: 'lidPhone and realPhone are required' });
    }
    const cleanLid = String(lidPhone).replace(/\D/g, '');
    const cleanReal = String(realPhone).replace(/\D/g, '');
    if (!cleanLid || !cleanReal) {
      return res.status(400).json({ error: 'Invalid phone numbers' });
    }
    if (cleanLid === cleanReal) {
      return res.status(400).json({ error: 'lidPhone and realPhone must differ' });
    }
    const pool = require('../db/pool');
    const { rowCount } = await pool.query(
      'UPDATE messages SET phone = $1 WHERE phone = $2',
      [cleanReal, cleanLid]
    );
    console.log(`[Messages] Mapped @lid ${cleanLid} → ${cleanReal} (${rowCount} messages moved) by ${req.user.username}`);
    res.json({ lidPhone: cleanLid, realPhone: cleanReal, messagesMoved: rowCount });
  } catch (err) {
    console.error('Map lid error:', err);
    res.status(500).json({ error: 'Failed to map lid' });
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
      conv.botActive = chatBotOn(conv.phone);
      conv.manualMode = isManualMode(conv.phone);
    }

    res.json({ conversations });
  } catch (err) {
    console.error('Search messages error:', err);
    res.status(500).json({ error: 'Failed to search messages' });
  }
});

module.exports = router;
