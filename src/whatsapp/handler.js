const Message = require('../models/Message');
const Client = require('../models/Client');
const ClientMedia = require('../models/ClientMedia');
const { saveMediaFromMessage } = require('./mediaService');
const { routeMessage } = require('../conversation/router');
const { load: loadSettings, save: saveSettings } = require('./botSettings');
const config = require('../config');

// ── Per-phone message buffer (debounce for multi-image bursts) ──
// When a user sends multiple images at once, WhatsApp fires them as separate
// message events within ~1s. We buffer them and process as one logical turn.
const MESSAGE_BUFFER_MS = 2000; // wait 2s after last message before processing
const phoneBuffers = new Map(); // phone → { messages: [], timer, sock }

function bufferMessage(phone, payload, sock) {
  if (!phoneBuffers.has(phone)) {
    phoneBuffers.set(phone, { messages: [], timer: null, sock });
  }
  const buf = phoneBuffers.get(phone);
  buf.messages.push(payload);
  buf.sock = sock;
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    const batch = buf.messages.splice(0);
    phoneBuffers.delete(phone);
    processBatch(phone, batch, sock).catch(err =>
      console.error('[WA] Batch processing error:', err.message)
    );
  }, MESSAGE_BUFFER_MS);
}

// Load persisted settings on startup (async)
let botActive = true;
let botMode = 'all';
let assignmentMode = 'automatic';
const enabledPhones = new Set();
const manualPhones = new Set();

(async function initSettings() {
  try {
    const saved = await loadSettings();
    botActive = saved.botActive;
    botMode = saved.botMode;
    assignmentMode = saved.assignmentMode || 'automatic';
    (saved.enabledPhones || []).forEach(p => enabledPhones.add(p));
    (saved.manualPhones || []).forEach(p => manualPhones.add(p));
    console.log(`[WA] Bot state restored: active=${botActive}, mode=${botMode}, assignment=${assignmentMode}, enabled=${enabledPhones.size}, manual=${manualPhones.size}`);
  } catch (err) {
    console.error('[WA] Failed to load settings:', err.message);
  }
})();

// Strip @s.whatsapp.net or @lid suffixes from phone numbers
function normalizePhone(phone) {
  return phone.replace(/@s\.whatsapp\.net$|@lid$/g, '');
}

async function persist() {
  try {
    await saveSettings({
      botActive,
      botMode,
      assignmentMode,
      enabledPhones: [...enabledPhones],
      manualPhones: [...manualPhones],
    });
  } catch (err) {
    console.error('[WA] Failed to persist settings:', err.message);
  }
}

function setBotActive(active) {
  botActive = active;
  console.log(`[WA] Bot ${active ? 'RESUMED' : 'PAUSED'}`);
  persist().catch(() => {});
}

function isBotActive() {
  return botActive;
}

function setBotMode(mode) {
  if (mode !== 'all' && mode !== 'selected') return;
  botMode = mode;
  enabledPhones.clear();
  console.log(`[WA] Bot mode set to: ${mode} (enabled list cleared)`);
  persist().catch(() => {});
}

function getBotMode() {
  return botMode;
}

function setAssignmentMode(mode) {
  if (mode !== 'manual' && mode !== 'automatic') return;
  assignmentMode = mode;
  console.log(`[WA] Assignment mode set to: ${mode}`);
  persist().catch(() => {});
}

function getAssignmentMode() {
  return assignmentMode;
}

// --- Chat enable/disable (selected mode) ---

function setChatEnabled(phone, enabled) {
  const clean = normalizePhone(phone);
  if (enabled) {
    enabledPhones.add(clean);
  } else {
    enabledPhones.delete(clean);
  }
  console.log(`[WA] Phone ${clean}: chat ${enabled ? 'ENABLED' : 'DISABLED'}`);
  persist().catch(() => {});
}

function isChatEnabled(phone) {
  if (botMode === 'all') return true;
  return enabledPhones.has(normalizePhone(phone));
}

function getEnabledPhones() {
  return [...enabledPhones];
}

// --- Manual mode (agent takeover) ---

function setManualMode(phone, manual) {
  const clean = normalizePhone(phone);
  if (manual) {
    manualPhones.add(clean);
  } else {
    manualPhones.delete(clean);
  }
  console.log(`[WA] Phone ${clean}: ${manual ? 'MANUAL (agent)' : 'BOT mode'}`);
  persist().catch(() => {});
}

function isManualMode(phone) {
  return manualPhones.has(normalizePhone(phone));
}

function getManualPhones() {
  return [...manualPhones];
}

function clearManualPhones() {
  const count = manualPhones.size;
  manualPhones.clear();
  console.log(`[WA] Cleared ${count} manual phones — bot will respond to all chats`);
  persist().catch(() => {});
}

// Determine if bot should respond to a specific phone
function shouldBotRespond(phone) {
  const clean = normalizePhone(phone);
  if (!botActive) return false;
  if (botMode === 'selected' && !enabledPhones.has(clean)) return false;
  if (manualPhones.has(clean)) return false;
  return true;
}

/**
 * Send a response to a WhatsApp JID and log it to the DB
 */
async function sendResponse(sock, remoteJid, response, msg, phone, client) {
  try {
    let logContent = typeof response === 'string' ? response : response.text || String(response);
    // Always send plain text — Baileys interactive list messages don't render
    // on personal WhatsApp accounts (button never shows). Plain text with
    // numbered emoji options works universally on all WA versions/devices.
    await sock.sendMessage(remoteJid, { text: logContent });
    await Message.create({
      phone,
      clientId: client?.id || null,
      direction: 'outbound',
      content: logContent,
    });
  } catch (err) {
    console.error('[WA] Error sending response:', err.message);
  }
}

/**
 * Process a batch of messages from the same phone as one logical turn.
 * Merges text, collects all media, processes together.
 */
async function processBatch(phone, batch, sock) {
  // Merge all text parts
  const textParts = batch.map(b => b.text).filter(Boolean);
  let combinedText = textParts.join(' ').trim();

  // Collect all saved media items
  const allMedia = batch.map(b => b.savedMedia).filter(Boolean);

  // Use the first message object for routing context (jid, etc.)
  const firstMsg = batch[0].msg;
  const remoteJid = firstMsg.key.remoteJid;

  const willRespond = batch[0].willRespond;
  if (!willRespond) return;

  if (allMedia.length > 0) {
    console.log(`[WA] Processing batch for ${phone}: ${textParts.length} text msgs + ${allMedia.length} media items`);
  }

  // Run Gemini analysis on ALL media in parallel now that the buffer window is closed
  if (config.gemini.enabled && allMedia.length > 0) {
    try {
      const { transcribeAudio, analyzeDocument } = require('../llm/mediaAnalysis');
      await Promise.all(allMedia.map(async (media) => {
        try {
          if (media.media_type === 'audio') {
            const transcription = await transcribeAudio(media.file_path, media.mime_type);
            if (transcription) {
              console.log(`[WA] Voice note transcribed:\n${transcription}`);
              // Audio transcription becomes the combined text
              combinedText = combinedText ? `${combinedText} ${transcription}` : transcription;
            }
          } else if (['image', 'document'].includes(media.media_type)) {
            const analysis = await analyzeDocument(media.file_path, media.mime_type, media.media_type);
            if (analysis) media.analysis = analysis;
          }
        } catch (err) {
          console.error(`[WA] Media analysis error for ${media.file_path}:`, err.message);
        }
      }));
    } catch (err) {
      console.error('[WA] Batch media analysis error:', err.message);
    }
  }

  // Build combined savedMedia: first item as base, allMedia array attached for batch extraction
  let savedMedia = allMedia.length > 0 ? allMedia[0] : null;
  if (allMedia.length > 1) {
    savedMedia = { ...allMedia[0], allMedia };
  }

  // Auto-detect complaints and create cases
  let client = await Client.findByPhone(phone);
  if (!client) client = await Client.findByPhone(phone);

  if (client && combinedText) {
    try {
      const messageTimestamp = firstMsg.messageTimestamp || new Date().toISOString();
      const complaintDetection = await fetch('http://localhost:3000/api/cases/detect-and-create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message_text: combinedText,
          phone: phone,
          client_id: client.id,
          message_timestamp: messageTimestamp,
        }),
      });
      if (complaintDetection.ok) {
        const result = await complaintDetection.json();
        if (result.is_complaint) {
          console.log(`[WA] Complaint detected for ${phone}: case #${result.case_id} (${result.case_type})`);
        }
      }
    } catch (err) {
      console.error('[WA] Complaint detection error:', err.message);
    }
  }

  const response = await routeMessage(phone, combinedText, firstMsg, savedMedia);

  if (response) {
    await sendResponse(sock, remoteJid, response, firstMsg, phone, client);
  }
}

async function handleIncomingMessage(msg, sock) {
  try {
    const remoteJid = msg.key.remoteJid;

    // Skip group messages and status broadcasts
    if (remoteJid.endsWith('@g.us') || remoteJid === 'status@broadcast') return;

    const isLid = remoteJid.endsWith('@lid');
    const rawPhone = remoteJid.replace(/@s\.whatsapp\.net$|@lid$/g, '');

    // For privacy @lid accounts, try to reuse the phone we mapped earlier so
    // the conversation doesn't split into random lid-only threads.
    let phone = rawPhone;
    if (isLid) {
      const mappedPhone = await Message.findPhoneByWaJid(remoteJid);
      if (mappedPhone) {
        phone = mappedPhone;
        console.log(`[WA] Mapped @lid ${rawPhone} to known phone ${mappedPhone}`);
      } else {
        console.log(`[WA] New @lid contact ${rawPhone} — conversation will use lid until a real phone is known`);
      }
    }

    const pushName = msg.pushName || msg.verifiedBizName || null;
    const isFromMe = msg.key.fromMe === true;
    let text = msg.message?.conversation
      || msg.message?.extendedTextMessage?.text
      || msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId
      || '';

    // Allow empty text only if there's media (document flow)
    const hasMedia = !!(
      msg.message?.imageMessage
      || msg.message?.documentMessage
      || msg.message?.audioMessage
      || msg.message?.videoMessage
    );

    if (!text && !hasMedia) return;

    // Anti-spam guard: never auto-reply to old messages (offline burst after
    // a reconnect). They are still logged to the dashboard below.
    const msgTs = Number(msg.messageTimestamp || 0) * 1000;
    const isStale = msgTs > 0 && (Date.now() - msgTs) > 120000;

    const willRespond = !isFromMe && !isStale && shouldBotRespond(phone);
    const tag = isFromMe ? '[DIRECT] '
      : isStale ? '[OLD] '
      : !botActive ? '[PAUSED] '
      : manualPhones.has(phone) ? '[MANUAL] '
      : (botMode === 'selected' && !enabledPhones.has(phone)) ? '[INACTIVE] '
      : '';
    console.log(`[WA] ${tag}Mensaje ${isFromMe ? 'enviado a' : 'de'} ${phone}: ${text || '[media]'}`);

    // For inbound messages, ensure we have a client record with the latest pushName.
    // For outbound messages (fromMe), do NOT create a client for the bot's own number.
    // For privacy @lid accounts we never trust pushName — WhatsApp often reports the
    // bot's own business name instead of the real contact, which pollutes clients.
    let client = null;
    if (!isFromMe) {
      client = await Client.findByPhone(phone);
      if (pushName && !isLid) {
        try {
          const updated = await Client.updateOrCreatePushName(phone, pushName);
          client = updated;
        } catch (_) {}
      }
    }

    // Auto-save media (file download only — no Gemini analysis yet)
    // Analysis happens in processBatch AFTER buffer window closes, so all images arrive together
    let savedMedia = null;
    if (hasMedia) {
      try {
        const mediaResult = await saveMediaFromMessage(msg, phone);
        if (mediaResult) {
          savedMedia = await ClientMedia.create({
            phone,
            clientId: client?.id || null,
            waMessageId: msg.key.id,
            mediaType: mediaResult.mediaType,
            mimeType: mediaResult.mimeType,
            originalName: mediaResult.fileName,
            savedName: mediaResult.savedName,
            filePath: mediaResult.filePath,
            fileSize: mediaResult.fileSize,
            context: 'conversation',
          });
        }
      } catch (mediaErr) {
        console.error('[WA] Error saving media:', mediaErr.message);
      }
    }

    // Log message (inbound from client or outbound direct from bot's phone)
    const logContent = text
      ? (savedMedia ? `${text}\n[📎 adjunto]` : text)
      : (savedMedia ? `[📎 ${savedMedia.media_type || 'archivo'}]` : '[mensaje]');

    try {
      await Message.create({
        waMessageId: msg.key.id,
        phone,
        clientId: client?.id || null,
        direction: isFromMe ? 'outbound' : 'inbound',
        content: logContent,
        mediaUrl: savedMedia ? `/api/media/${savedMedia.id}/download` : null,
        waJid: remoteJid,  // store real JID (may be @lid for privacy accounts)
      });
      console.log(`[WA] ✅ Mensaje guardado en BD: ${isFromMe ? 'outbound' : 'inbound'} | phone=${phone} | jid=${remoteJid}`);
    } catch (saveErr) {
      console.error(`[WA] ❌ Error guardando mensaje phone=${phone} jid=${remoteJid}:`, saveErr.message);
    }

    // Only buffer for processing if it's an inbound message that should get a bot response
    if (!isFromMe) {
      bufferMessage(phone, { msg, text, savedMedia, willRespond }, sock);
    }

  } catch (err) {
    console.error('[WA] Error procesando mensaje:', err);
    // Do NOT send an error reply here — it can spam users if the socket is flapping
    // or if a burst of old messages fails at once. Errors are logged and surfaced
    // in the dashboard instead.
  }
}

module.exports = {
  handleIncomingMessage,
  setBotActive, isBotActive,
  setBotMode, getBotMode,
  setAssignmentMode, getAssignmentMode,
  setChatEnabled, isChatEnabled, getEnabledPhones,
  setManualMode, isManualMode, getManualPhones, clearManualPhones,
  shouldBotRespond,
};
