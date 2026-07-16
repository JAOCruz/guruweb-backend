const path = require('path');
const fs = require('fs');
const config = require('../config');
const pool = require('../db/pool');
const { usePostgresAuthState } = require('./authStatePg');

// pino is an optional dependency used only by Baileys.
let logger = { level: 'silent' };
try {
  const pino = require('pino');
  logger = pino({ level: 'warn' });
} catch (err) {
  console.warn('[WA] pino not installed — using silent logger');
}

// Baileys is an optional dependency. In production (Railway) we may not have
// WhatsApp connected, but we still need to be able to load conversation flows
// for the dashboard simulator and other non-WhatsApp features.
let baileys = null;
try {
  baileys = require('@whiskeysockets/baileys');
  console.log('[WA] Baileys loaded successfully');
} catch (err) {
  console.warn('[WA] Baileys not installed — WhatsApp connection features disabled');
}

// sessionId -> { sock, open }. Sockets are tracked from creation (not just on
// open) so a session can never end up with two live sockets fighting over the
// same WhatsApp credentials (WhatsApp kills duplicates with a 440 conflict,
// which used to cause an endless connect/disconnect loop).
const connections = new Map();
// Generation counter per session: every createConnection/stopSession bumps it.
// Event handlers from older sockets check it and stop, so stale reconnect
// chains die instead of reconnecting on top of the current socket.
const generations = new Map();
const BAILEYS_MISSING_ERROR = 'WhatsApp/Baileys is not available in this environment';

function ensureBaileys() {
  if (!baileys) throw new Error(BAILEYS_MISSING_ERROR);
}

// Stop any live socket for a session and invalidate its reconnect chain.
function stopSession(sessionId) {
  generations.set(sessionId, (generations.get(sessionId) || 0) + 1);
  const existing = connections.get(sessionId);
  if (existing) {
    if (existing.sock) {
      try { existing.sock.end(); } catch (_) { /* already closed */ }
    }
    connections.delete(sessionId);
  }
}

async function createConnection(sessionId, onQR, onConnected, onMessage) {
  ensureBaileys();

  // Kill any previous socket (open or still connecting) for this session.
  stopSession(sessionId);
  const gen = generations.get(sessionId);
  const isCurrent = () => generations.get(sessionId) === gen;

  console.log(`[WA] Loading auth state from PostgreSQL for session: ${sessionId}`);
  const { state, saveCreds } = await usePostgresAuthState(sessionId);
  console.log(`[WA] Auth state loaded. Has creds: ${!!state.creds}, registered: ${state.creds?.registered || false}`);

  console.log(`[WA] Fetching latest WA version...`);
  const { version, isLatest } = await baileys.fetchLatestBaileysVersion();
  console.log(`[WA] Using WA version: ${version} (latest: ${isLatest})`);

  console.log(`[WA] Creating socket for ${sessionId}...`);
  const sock = baileys.default({
    version,
    auth: {
      creds: state.creds,
      keys: baileys.makeCacheableSignalKeyStore(state.keys, logger),
    },
    logger,
    browser: baileys.Browsers.ubuntu('Chrome'),
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 250,
  });

  // Track immediately so stopSession() can kill a still-connecting socket.
  connections.set(sessionId, { sock, open: false });

  console.log(`[WA] Socket created for ${sessionId}. Waiting for events...`);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Log ALL connection updates
    console.log(`[WA] Connection update for ${sessionId}:`, JSON.stringify({
      connection: connection || null,
      hasQR: !!qr,
      qrLength: qr?.length || 0,
    }));

    if (!isCurrent()) {
      // A newer socket replaced this one. Make sure this one dies quietly.
      if (connection === 'open') {
        console.log(`[WA] Stale socket for ${sessionId} opened after replacement — closing it.`);
        try { sock.end(); } catch (_) { /* ignore */ }
      }
      return;
    }

    if (qr && onQR) {
      console.log(`[WA] ✅ QR code received for ${sessionId}! Length: ${qr.length}`);
      onQR(qr);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message;
      const shouldReconnect = statusCode !== baileys.DisconnectReason.loggedOut && statusCode !== 405;

      console.log(`[WA] Session ${sessionId} disconnected. Code: ${statusCode}${errMsg ? ` (${errMsg})` : ''}`);
      connections.delete(sessionId);

      if (shouldReconnect) {
        console.log(`[WA] Reconnecting session ${sessionId} in 3s...`);
        setTimeout(async () => {
          if (!isCurrent()) return; // replaced/stopped meanwhile
          // Respect manual disconnect: if the user explicitly stopped the session,
          // do not auto-reconnect.
          try {
            const { rows } = await pool.query(
              `SELECT manual_disconnect FROM wa_credentials WHERE session_id = $1`,
              [sessionId]
            );
            if (rows[0]?.manual_disconnect === true) {
              console.log(`[WA] Skipping auto-reconnect for ${sessionId} — manual disconnect is set`);
              return;
            }
          } catch (dbErr) {
            console.error(`[WA] Failed to check manual_disconnect for ${sessionId}:`, dbErr.message);
          }
          createConnection(sessionId, onQR, onConnected, onMessage).catch(err => {
            console.error(`[WA] Reconnect failed for ${sessionId}:`, err.message);
          });
        }, 3000);
      } else {
        console.log(`[WA] Session ${sessionId} logged out. Generate new QR to reconnect.`);
        // Dead creds: wipe them so startup auto-reconnect doesn't try them again
        pool.query(`DELETE FROM wa_credentials WHERE session_id = $1`, [sessionId])
          .then(() => console.log(`[WA] Cleared dead credentials for ${sessionId} after logout`))
          .catch(err => console.error(`[WA] Failed to clear dead credentials:`, err.message));
      }
    }

    if (connection === 'open') {
      console.log(`[WA] ✅ Session ${sessionId} connected successfully!`);
      const entry = connections.get(sessionId);
      if (entry) entry.open = true;
      else connections.set(sessionId, { sock, open: true });
      if (onConnected) onConnected(sock);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    if (!isCurrent()) return; // stale socket must not process messages
    for (const msg of messages) {
      if (onMessage) onMessage(msg, sock);
    }
  });

  return sock;
}

function getConnection(sessionId) {
  const entry = connections.get(sessionId);
  return entry && entry.open ? entry.sock : null;
}

async function sendMessage(sessionId, jid, content) {
  ensureBaileys();
  const entry = connections.get(sessionId);
  if (!entry || !entry.open) throw new Error(`No active session: ${sessionId}`);
  return entry.sock.sendMessage(jid, content);
}

function disconnectSession(sessionId) {
  if (!baileys) return;
  stopSession(sessionId);
}

async function reconnectSavedSessions(onMessage) {
  if (!baileys) {
    console.log('[WA] Skipping auto-reconnect — Baileys not available');
    return;
  }

  try {
    const { rows } = await pool.query(
      `SELECT session_id FROM wa_credentials
       WHERE creds IS NOT NULL AND creds::text != '{}'
       AND session_id LIKE 'user_%'
       AND manual_disconnect IS NOT TRUE`
    );

    for (const row of rows) {
      const sessionId = row.session_id;
      console.log(`[WA] Auto-reconnecting session: ${sessionId}`);
      try {
        await createConnection(
          sessionId,
          null, // No QR callback — already authenticated
          () => console.log(`[WA] ✅ Auto-reconnected session: ${sessionId}`),
          onMessage
        );
      } catch (err) {
        console.error(`[WA] Failed to auto-reconnect ${sessionId}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[WA] Error loading saved sessions from DB:', err.message);
  }
}

function getAnyConnection() {
  for (const [id, entry] of connections) {
    if (entry && entry.open) return { sessionId: id, sock: entry.sock };
  }
  return null;
}

module.exports = { createConnection, getConnection, getAnyConnection, sendMessage, disconnectSession, stopSession, reconnectSavedSessions };
