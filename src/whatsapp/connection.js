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

// libsignal prints a FULL SessionEntry dump via console.info every time a
// session is replaced ("Closing session: {...}") — hundreds of lines per
// message during churn, which floods Railway's log pipeline (500 logs/sec
// cap) and drowns real logs. Filter just that one message.
const _origConsoleInfo = console.info.bind(console);
console.info = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('Closing session')) return;
  _origConsoleInfo(...args);
};

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
// Last time ANY inbound message event arrived per session. WhatsApp can leave
// the socket "open" (sends still work) while silently stopping delivery of
// inbound messages — a zombie state only a full reconnect fixes.
const lastActivity = new Map();
// Handlers from the latest createConnection per session, so the watchdog can
// rebuild the socket with the same callbacks.
const sessionHandlers = new Map();
// Active critical operations per session (connection setup, key exchanges,
// credential writes). SIGTERM waits for these to finish before shutting down
// so Railway cannot restart the container mid-handshake and corrupt keys.
const criticalOps = new Map();
const BAILEYS_MISSING_ERROR = 'WhatsApp/Baileys is not available in this environment';

function ensureBaileys() {
  if (!baileys) throw new Error(BAILEYS_MISSING_ERROR);
}

function beginCritical(sessionId, label) {
  const count = (criticalOps.get(sessionId) || 0) + 1;
  criticalOps.set(sessionId, count);
  console.log(`[WA] Critical operation started for ${sessionId}: ${label} (count=${count})`);
}

function endCritical(sessionId, label) {
  const count = (criticalOps.get(sessionId) || 0) - 1;
  if (count <= 0) criticalOps.delete(sessionId);
  else criticalOps.set(sessionId, count);
  console.log(`[WA] Critical operation ended for ${sessionId}: ${label} (count=${Math.max(0, count)})`);
}

function hasAnyCriticalOperation() {
  for (const count of criticalOps.values()) {
    if (count > 0) return true;
  }
  return false;
}

function waitForCriticalOperations(timeoutMs = 10000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!hasAnyCriticalOperation()) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(check, 100);
    };
    check();
  });
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

async function createConnection(sessionId, onQR, onConnected, onMessage, onHistory) {
  ensureBaileys();
  beginCritical(sessionId, 'createConnection');

  try {
    // Kill any previous socket (open or still connecting) for this session.
    stopSession(sessionId);
    const gen = generations.get(sessionId);
    const isCurrent = () => generations.get(sessionId) === gen;
    sessionHandlers.set(sessionId, { onQR, onConnected, onMessage, onHistory });
    lastActivity.set(sessionId, Date.now());

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
    // Don't pull the entire message history on every reconnect — it can take
    // days and re-triggers WhatsApp's "first time" sync prompt. Live messages
    // still arrive, and existing DB context is used for the bot.
    syncFullHistory: false,
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
        // 440 (conflict) means another socket with the same creds owns the
        // session — typically the NEW container during a Railway rolling
        // deploy. Give the platform time to kill this old container before
        // retrying, otherwise both containers fight in a connect/disconnect
        // war and the session ends up corrupted.
        const delayMs = statusCode === 440 ? 60000 : 3000;
        console.log(`[WA] Reconnecting session ${sessionId} in ${delayMs / 1000}s...`);
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
          beginCritical(sessionId, 'autoReconnect');
          createConnection(sessionId, onQR, onConnected, onMessage, onHistory)
            .catch(err => console.error(`[WA] Reconnect failed for ${sessionId}:`, err.message))
            .finally(() => endCritical(sessionId, 'autoReconnect'));
        }, delayMs);
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
    lastActivity.set(sessionId, Date.now());
    if (type !== 'notify') return;
    if (!isCurrent()) return; // stale socket must not process messages
    for (const msg of messages) {
      if (onMessage) onMessage(msg, sock);
    }
  });

  // History sync (sent by the phone after a fresh link, or on demand): recent
  // messages per chat. We used to DROP these — that's why conversations looked
  // frozen after every re-link. Now we store them (no replies, no notifications).
  sock.ev.on('messaging-history.set', ({ messages: historyMessages }) => {
    lastActivity.set(sessionId, Date.now());
    if (!isCurrent()) return;
    if (!onHistory) return;
    console.log(`[WA] History sync for ${sessionId}: ${historyMessages.length} messages received — storing`);
    for (const msg of historyMessages) {
      try { onHistory(msg); } catch (err) { console.error('[WA] History message error:', err.message); }
    }
  });

    return sock;
  } finally {
    // createConnection itself is done; the socket continues to live, but the
    // initial handshake/key exchange window is over. Reconnect chains spawned
    // inside the handlers begin/end their own critical markers.
    endCritical(sessionId, 'createConnection');
  }
}

async function isManuallyDisconnected(sessionId) {
  try {
    const { rows } = await pool.query(
      `SELECT manual_disconnect FROM wa_credentials WHERE session_id = $1`,
      [sessionId]
    );
    return rows[0]?.manual_disconnect === true;
  } catch (err) {
    console.error(`[WA] Failed to check manual_disconnect for ${sessionId}:`, err.message);
    return false;
  }
}

// Force-drop the current socket and rebuild it with the stored handlers.
// Used by the watchdog when a session goes zombie (open but silent).
async function forceReconnect(sessionId) {
  const handlers = sessionHandlers.get(sessionId);
  if (!handlers) {
    console.log(`[WA] forceReconnect skipped for ${sessionId} — no stored handlers`);
    return false;
  }
  if (await isManuallyDisconnected(sessionId)) {
    console.log(`[WA] forceReconnect skipped for ${sessionId} — manual disconnect is set`);
    return false;
  }
  console.log(`[WA] Force-reconnecting session ${sessionId}...`);
  beginCritical(sessionId, 'forceReconnect');
  try {
    await createConnection(sessionId, handlers.onQR, handlers.onConnected, handlers.onMessage, handlers.onHistory);
    return true;
  } catch (err) {
    console.error(`[WA] Force-reconnect failed for ${sessionId}:`, err.message);
    return false;
  } finally {
    endCritical(sessionId, 'forceReconnect');
  }
}

// Watchdog: if an open session has delivered NO inbound message events for
// QUIET_THRESHOLD_MS, the connection is considered zombie (WhatsApp stopped
// routing messages to it even though sends still work). Rebuild it. A quiet
// but healthy session simply gets a harmless refresh with saved creds
// (syncFullHistory is off, so this takes seconds).
const QUIET_THRESHOLD_MS = 3 * 60 * 60 * 1000; // 3h
const WATCHDOG_INTERVAL_MS = 15 * 60 * 1000; // check every 15 min
setInterval(() => {
  for (const [sessionId, entry] of connections) {
    if (!entry || !entry.open) continue;
    const quietFor = Date.now() - (lastActivity.get(sessionId) || 0);
    if (quietFor > QUIET_THRESHOLD_MS) {
      console.log(`[WA] Watchdog: session ${sessionId} silent for ${Math.round(quietFor / 3600000)}h — treating as zombie, force-reconnecting`);
      forceReconnect(sessionId);
    }
  }
}, WATCHDOG_INTERVAL_MS).unref();

function getConnection(sessionId) {
  const entry = connections.get(sessionId);
  return entry && entry.open ? entry.sock : null;
}

// Soft refresh: nudge the open socket so WhatsApp re-syncs app state and
// re-opens the message pipe. Does NOT drop the socket, so it is safe to call
// from the dashboard when chats look frozen but status says connected.
async function resyncSession(sessionId) {
  const entry = connections.get(sessionId);
  if (!entry || !entry.open) {
    return { success: false, message: 'No active session to resync' };
  }
  const { sock } = entry;
  try {
    // 1) Re-sync app state (chats, contacts, archive, etc.)
    if (typeof sock.resyncAppState === 'function') {
      await sock.resyncAppState(baileys.ALL_WA_PATCH_NAMES, false);
      console.log(`[WA] resyncAppState completed for ${sessionId}`);
    }
    // 2) Send an available presence update to wake up the message stream
    if (typeof sock.sendPresenceUpdate === 'function') {
      await sock.sendPresenceUpdate('available');
      console.log(`[WA] sendPresenceUpdate('available') completed for ${sessionId}`);
    }
    lastActivity.set(sessionId, Date.now());
    return { success: true, message: 'Sesión refrescada' };
  } catch (err) {
    console.error(`[WA] resyncSession failed for ${sessionId}:`, err.message);
    return { success: false, message: err.message };
  }
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

async function reconnectSavedSessions(onMessage, onHistory) {
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
      beginCritical(sessionId, 'startupAutoReconnect');
      try {
        await createConnection(
          sessionId,
          null, // No QR callback — already authenticated
          () => console.log(`[WA] ✅ Auto-reconnected session: ${sessionId}`),
          onMessage,
          onHistory
        );
      } catch (err) {
        console.error(`[WA] Failed to auto-reconnect ${sessionId}:`, err.message);
      } finally {
        endCritical(sessionId, 'startupAutoReconnect');
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

// Drop every live socket immediately (used on SIGTERM so a dying container
// releases the session instead of fighting the new one with 440 conflicts).
function stopAllSessions() {
  for (const sessionId of [...connections.keys()]) {
    try { stopSession(sessionId); } catch (_) { /* already closed */ }
  }
}

module.exports = { createConnection, getConnection, getAnyConnection, sendMessage, disconnectSession, stopSession, stopAllSessions, forceReconnect, reconnectSavedSessions, resyncSession, waitForCriticalOperations, hasAnyCriticalOperation };
