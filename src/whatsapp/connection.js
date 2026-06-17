const path = require('path');
const fs = require('fs');
const config = require('../config');

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

const connections = new Map();
const BAILEYS_MISSING_ERROR = 'WhatsApp/Baileys is not available in this environment';

function ensureBaileys() {
  if (!baileys) throw new Error(BAILEYS_MISSING_ERROR);
}

async function createConnection(sessionId, onQR, onConnected, onMessage) {
  ensureBaileys();

  const sessionDir = path.join(config.wa.sessionDir, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  console.log(`[WA] Loading auth state from: ${sessionDir}`);
  const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir);
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

    if (qr && onQR) {
      console.log(`[WA] ✅ QR code received for ${sessionId}! Length: ${qr.length}`);
      onQR(qr);
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== baileys.DisconnectReason.loggedOut && statusCode !== 405;

      console.log(`[WA] Session ${sessionId} disconnected. Code: ${statusCode}`);
      connections.delete(sessionId);

      if (shouldReconnect) {
        console.log(`[WA] Reconnecting session ${sessionId}...`);
        createConnection(sessionId, onQR, onConnected, onMessage);
      } else {
        console.log(`[WA] Session ${sessionId} logged out. Generate new QR to reconnect.`);
      }
    }

    if (connection === 'open') {
      console.log(`[WA] ✅ Session ${sessionId} connected successfully!`);
      connections.set(sessionId, sock);
      if (onConnected) onConnected(sock);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (onMessage) onMessage(msg, sock);
    }
  });

  return sock;
}

function getConnection(sessionId) {
  return connections.get(sessionId) || null;
}

async function sendMessage(sessionId, jid, content) {
  ensureBaileys();
  const sock = connections.get(sessionId);
  if (!sock) throw new Error(`No active session: ${sessionId}`);
  return sock.sendMessage(jid, content);
}

function disconnectSession(sessionId) {
  if (!baileys) return;
  const sock = connections.get(sessionId);
  if (sock) {
    sock.end();
    connections.delete(sessionId);
  }
}

async function reconnectSavedSessions(onMessage) {
  if (!baileys) {
    console.log('[WA] Skipping auto-reconnect — Baileys not available');
    return;
  }

  const sessionsDir = config.wa.sessionDir;
  if (!fs.existsSync(sessionsDir)) return;

  const dirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('user_'));

  for (const dir of dirs) {
    const sessionId = dir.name;
    const credsFile = path.join(sessionsDir, sessionId, 'creds.json');

    // Only reconnect if credentials exist (previously authenticated)
    if (!fs.existsSync(credsFile)) continue;

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
}

function getAnyConnection() {
  for (const [id, sock] of connections) {
    if (sock) return { sessionId: id, sock };
  }
  return null;
}

module.exports = { createConnection, getConnection, getAnyConnection, sendMessage, disconnectSession, reconnectSavedSessions };
