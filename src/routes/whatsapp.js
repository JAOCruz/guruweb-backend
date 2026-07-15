const express = require('express');
const fs = require('fs');
const path = require('path');
const { createConnection, getConnection, getAnyConnection, disconnectSession, stopSession } = require('../whatsapp/connection');
const { handleIncomingMessage, setBotActive, isBotActive, setBotMode, getBotMode, setAssignmentMode, getAssignmentMode } = require('../whatsapp/handler');
const { authenticate, requireRole } = require('../middleware/auth');
const config = require('../config');
const pool = require('../db/pool');
const Client = require('../models/Client');

const router = express.Router();
router.use(authenticate);

// Admin-only middleware for WhatsApp control endpoints
const requireAdmin = requireRole('admin');

async function clearPendingQR(sessionId) {
  try {
    await pool.query(
      `UPDATE wa_credentials SET pending_qr = NULL, pending_qr_at = NULL WHERE session_id = $1`,
      [sessionId]
    );
  } catch (err) {
    console.error(`[WA] Failed to clear pending QR for ${sessionId}:`, err.message);
  }
}

async function clearSessionCredentials(sessionId) {
  try {
    await pool.query(
      `DELETE FROM wa_credentials WHERE session_id = $1`,
      [sessionId]
    );
    console.log(`[WA] Cleared stored credentials for ${sessionId}`);
  } catch (err) {
    console.error(`[WA] Failed to clear credentials for ${sessionId}:`, err.message);
  }
}

async function savePendingQR(sessionId, qr) {
  try {
    await pool.query(
      `INSERT INTO wa_credentials (session_id, creds, keys, pending_qr, pending_qr_at)
       VALUES ($1, '{}', '{}', $2, NOW())
       ON CONFLICT (session_id) DO UPDATE SET
         pending_qr = EXCLUDED.pending_qr,
         pending_qr_at = EXCLUDED.pending_qr_at`,
      [sessionId, qr]
    );
  } catch (err) {
    console.error(`[WA] Failed to save pending QR for ${sessionId}:`, err.message);
  }
}

router.post('/connect', async (req, res) => {
  try {
    const sessionId = `user_${req.user.id}`;

    const existing = getConnection(sessionId);
    if (existing) {
      return res.json({ status: 'already_connected', sessionId });
    }

    // Kill any half-open socket or pending reconnect chain for this session
    // before wiping credentials — otherwise the old chain reconnects with the
    // old creds and fights the new socket (WhatsApp 440 conflict loop).
    stopSession(sessionId);

    // Clear old session files for a fresh QR code
    const sessionDir = path.join(config.wa.sessionDir, sessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      console.log(`[WA] Cleared old session files for ${sessionId}`);
    }

    // Clear any old pending QR and stored credentials for a truly fresh session
    await clearPendingQR(sessionId);
    await clearSessionCredentials(sessionId);

    console.log(`[WA] Starting fresh connection for ${sessionId}...`);

    await createConnection(
      sessionId,
      (qr) => {
        console.log(`[WA] QR code received for ${sessionId} (length: ${qr.length})`);
        savePendingQR(sessionId, qr);
      },
      () => {
        console.log(`[WA] Session ${sessionId} connected! Clearing QR.`);
        clearPendingQR(sessionId);
      },
      handleIncomingMessage
    );

    res.json({ status: 'connecting', sessionId, message: 'Use GET /api/whatsapp/qr to retrieve QR code' });
  } catch (err) {
    console.error('WA connect error:', err);
    res.status(500).json({ error: 'Failed to start WhatsApp connection' });
  }
});

router.get('/qr', async (req, res) => {
  try {
    const sessionId = `user_${req.user.id}`;
    const { rows } = await pool.query(
      `SELECT pending_qr FROM wa_credentials WHERE session_id = $1 AND pending_qr_at > NOW() - INTERVAL '5 minutes'`,
      [sessionId]
    );
    const qr = rows[0]?.pending_qr || null;
    if (qr) console.log(`[WA] QR request for ${sessionId}: FOUND`);
    if (!qr) {
      return res.json({ status: 'no_qr', message: 'No QR available. Already connected or not yet generated.' });
    }
    res.json({ qr });
  } catch (err) {
    console.error('[WA] QR request error:', err.message);
    res.status(500).json({ error: 'Failed to retrieve QR code' });
  }
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

router.post('/disconnect', async (req, res) => {
  try {
    const sessionId = `user_${req.user.id}`;
    disconnectSession(sessionId);
    await clearPendingQR(sessionId);
    // Persist so startup auto-reconnect skips this session until a fresh /connect
    await pool.query(
      `UPDATE wa_credentials SET manual_disconnect = TRUE WHERE session_id = $1`,
      [sessionId]
    );
    res.json({ message: 'Disconnected' });
  } catch (err) {
    console.error('[WA] Disconnect error:', err.message);
    res.status(500).json({ error: 'Failed to disconnect' });
  }
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
    // Try real phone JID first, then LID privacy JID
    const jids = [phone + '@s.whatsapp.net'];
    if (/^\d{15,}$/.test(phone)) {
      jids.push(phone + '@lid');
    }

    for (const jid of jids) {
      try {
        url = await conn.sock.profilePictureUrl(jid, 'image');
        if (url) break;
      } catch {
        // 404 = no profile pic, 401 = privacy — both normal
      }
    }

    profilePicCache.set(phone, { url, fetchedAt: Date.now() });

    // Persist to client record if available
    if (url) {
      try {
        await Client.updateProfilePic(phone, url);
      } catch (persistErr) {
        console.error('[WA] Failed to persist profile pic:', persistErr.message);
      }
    }

    res.json({ url });
  } catch (err) {
    console.error('Profile pic error:', err.message);
    res.json({ url: null });
  }
});

module.exports = router;
