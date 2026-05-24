const express = require('express');
const fs = require('fs');
const path = require('path');
const { createConnection, getConnection, getAnyConnection, disconnectSession } = require('../whatsapp/connection');
const { handleIncomingMessage, setBotActive, isBotActive, setBotMode, getBotMode, setAssignmentMode, getAssignmentMode } = require('../whatsapp/handler');
const { authenticate, requireRole } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();
router.use(authenticate);

// Admin-only middleware for WhatsApp control endpoints
const requireAdmin = requireRole('admin');

const pendingQRs = new Map();

router.post('/connect', async (req, res) => {
  try {
    const sessionId = `user_${req.user.id}`;

    const existing = getConnection(sessionId);
    if (existing) {
      return res.json({ status: 'already_connected', sessionId });
    }

    // Clear old session files for a fresh QR code
    const sessionDir = path.join(config.wa.sessionDir, sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[WA] Cleared old session files for ${sessionId}`);
    }

    // Clear any old pending QR
    pendingQRs.delete(sessionId);

    console.log(`[WA] Starting fresh connection for ${sessionId}...`);

    await createConnection(
      sessionId,
      (qr) => {
        console.log(`[WA] QR code received for ${sessionId} (length: ${qr.length})`);
        pendingQRs.set(sessionId, qr);
      },
      () => {
        console.log(`[WA] Session ${sessionId} connected! Clearing QR.`);
        pendingQRs.delete(sessionId);
      },
      handleIncomingMessage
    );

    res.json({ status: 'connecting', sessionId, message: 'Use GET /api/whatsapp/qr to retrieve QR code' });
  } catch (err) {
    console.error('WA connect error:', err);
    res.status(500).json({ error: 'Failed to start WhatsApp connection' });
  }
});

router.get('/qr', (req, res) => {
  const sessionId = `user_${req.user.id}`;
  const qr = pendingQRs.get(sessionId);
  if (qr) console.log(`[WA] QR request for ${sessionId}: FOUND`);
  if (!qr) {
    return res.json({ status: 'no_qr', message: 'No QR available. Already connected or not yet generated.' });
  }
  res.json({ qr });
});

router.get('/status', (req, res) => {
  // Check user-specific session first, then fall back to any active connection
  const sessionId = `user_${req.user.id}`;
  let connected = !!getConnection(sessionId);
  let activeSession = sessionId;
  if (!connected) {
    const any = getAnyConnection();
    if (any) {
      connected = true;
      activeSession = any.sessionId;
    }
  }
  res.json({ sessionId: activeSession, connected, botActive: isBotActive(), botMode: getBotMode(), assignmentMode: getAssignmentMode() });
});

router.post('/bot-toggle', requireAdmin, (req, res) => {
  const current = isBotActive();
  setBotActive(!current);
  res.json({ botActive: !current });
});

router.post('/bot-mode', requireAdmin, (req, res) => {
  const { mode } = req.body;
  if (mode !== 'all' && mode !== 'selected') {
    return res.status(400).json({ error: 'Mode must be "all" or "selected"' });
  }
  setBotMode(mode);
  res.json({ botMode: mode });
});

router.post('/assignment-mode', requireAdmin, (req, res) => {
  const { mode } = req.body;
  if (mode !== 'manual' && mode !== 'automatic') {
    return res.status(400).json({ error: 'Assignment mode must be "manual" or "automatic"' });
  }
  setAssignmentMode(mode);
  res.json({ assignmentMode: mode });
});

router.post('/disconnect', (req, res) => {
  const sessionId = `user_${req.user.id}`;
  disconnectSession(sessionId);
  pendingQRs.delete(sessionId);
  res.json({ message: 'Disconnected' });
});

// Profile picture cache: Map<phone, { url, fetchedAt }>
const profilePicCache = new Map();
const PIC_CACHE_TTL = 60 * 60 * 1000; // 1 hour

router.get('/profile-pic/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;

    const cached = profilePicCache.get(phone);
    if (cached && Date.now() - cached.fetchedAt < PIC_CACHE_TTL) {
      return res.json({ url: cached.url });
    }

    const conn = getAnyConnection();
    if (!conn) return res.json({ url: null });

    let url = null;
    try {
      url = await conn.sock.profilePictureUrl(phone + '@s.whatsapp.net', 'image');
    } catch {
      // 404 = no profile pic, 401 = privacy — both normal
    }

    profilePicCache.set(phone, { url, fetchedAt: Date.now() });
    res.json({ url });
  } catch (err) {
    console.error('Profile pic error:', err.message);
    res.json({ url: null });
  }
});

module.exports = router;
