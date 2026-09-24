const crypto = require('crypto');
const Message = require('../models/Message');
const Client = require('../models/Client');
const ClientMedia = require('../models/ClientMedia');
const Notification = require('../models/Notification');
const storage = require('../utils/storage');
const { routeMessage, AI_DEFERRED } = require('../conversation/router');
const { shouldBotRespond } = require('./handler');
const cloudApi = require('./cloudApi');
const outgoing = require('./outgoing');
const { getQuotaBackoffRemaining } = require('../llm/generate');

const processingIds = new Set();
const pendingRetries = new Map();
const MAX_RETRY_ATTEMPTS = 6;

const MIME_EXTENSIONS = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'application/pdf': '.pdf',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'audio/ogg; codecs=opus': '.ogg',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
};

function getExtension(mimeType, fileName) {
  if (fileName) {
    const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')) : '';
    if (ext) return ext;
  }
  return MIME_EXTENSIONS[mimeType] || '.bin';
}

function getPushName(value, from) {
  const contacts = value?.contacts || [];
  const contact = contacts.find((c) => c.wa_id === from);
  return contact?.profile?.name || null;
}

function normalizePhone(phone) {
  return String(phone).replace(/\D/g, '');
}

async function notifyNewMessage(client, phone, text) {
  try {
    if (!client?.assigned_to) return;
    const pool = require('../db/pool');
    const { rows } = await pool.query(
      `SELECT id FROM notifications
       WHERE user_id = $1 AND read = false AND type = 'message' AND metadata->>'phone' = $2 LIMIT 1`,
      [client.assigned_to, phone]
    );
    if (rows.length > 0) return;
    const label = client.name && !/^\d{10,}$/.test(client.name) ? client.name : phone;
    const preview = (text || '[media]').substring(0, 60);
    await Notification.create({
      userId: client.assigned_to,
      type: 'message',
      title: `💬 Nuevo mensaje de ${label}`,
      message: preview,
      link: `/bot-messages?phone=${encodeURIComponent(phone)}`,
      metadata: { phone, clientId: client.id },
    });
  } catch (err) {
    console.error('[WA Cloud] New-message notification error:', err.message);
  }
}

async function saveCloudMedia(mediaId, mimeType, fileName, mediaType, phone, waMessageId) {
  const meta = await cloudApi.getMediaUrl(mediaId);
  const buffer = await cloudApi.downloadMedia(meta.url);
  const ext = getExtension(meta.mime_type || mimeType, fileName);
  const timestamp = Date.now();
  const savedName = `${timestamp}_${waMessageId}${ext}`;
  const filePath = storage.saveBuffer(buffer, `media/${phone}`, savedName);
  return {
    filePath,
    fileName: fileName || savedName,
    savedName,
    mimeType: meta.mime_type || mimeType,
    mediaType,
    fileSize: buffer.length,
  };
}

async function sendReply(phone, text, client) {
  try {
    const sent = await outgoing.sendText(phone, text);
    await Message.create({
      waMessageId: sent.key?.id || null,
      phone,
      clientId: client?.id || null,
      direction: 'outbound',
      content: text,
      waJid: `${phone}@s.whatsapp.net`,
    });
  } catch (err) {
    console.error('[WA Cloud] Failed to send reply:', err.message);
  }
}

async function handleResponse(phone, text, normalizedMsg, savedMedia, client) {
  try {
    const response = await routeMessage(phone, text, normalizedMsg, savedMedia);
    if (response === AI_DEFERRED) {
      scheduleRetry(phone, text, normalizedMsg, savedMedia, client);
    } else if (response) {
      await sendReply(phone, response, client);
    }
  } catch (err) {
    console.error('[WA Cloud] Error handling response:', err.message);
  }
}

function scheduleRetry(phone, text, normalizedMsg, savedMedia, client) {
  const backoffMs = getQuotaBackoffRemaining() || 30000;
  const delayMs = backoffMs + 5000;

  const existing = pendingRetries.get(phone);
  if (existing) {
    existing.text = `${existing.text} ${text}`.trim();
    if (savedMedia) existing.savedMedia = savedMedia;
    clearTimeout(existing.timer);
  }
  const entry = existing || { text, savedMedia, normalizedMsg, client, attempts: 0 };

  entry.timer = setTimeout(async () => {
    pendingRetries.delete(phone);
    entry.attempts++;
    if (!shouldBotRespond(phone)) {
      console.log(`[WA Cloud] AI retry cancelled — bot no longer responding to ${phone}`);
      return;
    }
    try {
      const response = await routeMessage(phone, entry.text, entry.normalizedMsg, entry.savedMedia);
      if (response && response !== AI_DEFERRED) {
        await sendReply(phone, response, entry.client);
      } else if (response === AI_DEFERRED && entry.attempts < MAX_RETRY_ATTEMPTS) {
        scheduleRetry(phone, entry.text, entry.normalizedMsg, entry.savedMedia, entry.client);
      } else if (response === AI_DEFERRED) {
        await sendReply(phone,
          '🦉 Estamos procesando varias solicitudes en este momento. Un miembro de nuestro equipo le atenderá en breve, gracias por su paciencia.',
          entry.client);
      }
    } catch (err) {
      console.error('[WA Cloud] AI retry error:', err.message);
    }
  }, delayMs);

  pendingRetries.set(phone, entry);
  console.log(`[WA Cloud] AI backoff — message from ${phone} deferred, retry in ${Math.round(delayMs / 1000)}s`);
}

function normalizeMessage(message, value) {
  const phone = normalizePhone(message.from);
  const remoteJid = `${phone}@s.whatsapp.net`;
  const pushName = getPushName(value, message.from);
  const timestamp = Number(message.timestamp) || Math.floor(Date.now() / 1000);

  const normalized = {
    key: { id: message.id, remoteJid, fromMe: false },
    messageTimestamp: timestamp,
    pushName,
    message: {},
  };

  let text = '';

  switch (message.type) {
    case 'text': {
      text = message.text?.body || '';
      normalized.message.conversation = text;
      break;
    }
    case 'image': {
      const img = message.image || {};
      text = img.caption || '';
      normalized.message.imageMessage = {
        mimetype: img.mime_type,
        caption: img.caption || '',
        mediaId: img.id,
      };
      break;
    }
    case 'document': {
      const doc = message.document || {};
      text = doc.caption || '';
      normalized.message.documentMessage = {
        mimetype: doc.mime_type,
        caption: doc.caption || '',
        fileName: doc.filename || 'document',
        mediaKey: true,
        mediaId: doc.id,
      };
      break;
    }
    case 'audio': {
      const aud = message.audio || {};
      normalized.message.audioMessage = {
        mimetype: aud.mime_type,
        mediaKey: true,
        mediaId: aud.id,
      };
      break;
    }
    case 'video': {
      const vid = message.video || {};
      text = vid.caption || '';
      normalized.message.videoMessage = {
        mimetype: vid.mime_type,
        caption: vid.caption || '',
        mediaId: vid.id,
      };
      break;
    }
    case 'location': {
      const loc = message.location || {};
      const lat = loc.latitude;
      const lng = loc.longitude;
      const label = loc.name || loc.address || '';
      const link = (lat != null && lng != null) ? `https://maps.google.com/?q=${lat},${lng}` : '';
      text = `📍 Ubicación compartida${label ? `: ${label}` : ''}${link ? `\n${link}` : ''}`.trim();
      normalized.message.conversation = text;
      break;
    }
    default:
      text = message[type]?.body || message[type]?.caption || '';
      normalized.message.conversation = text;
  }

  return { normalized, text };
}

async function getQuotedContent(quotedId) {
  try {
    const row = await Message.findByWaMessageId(quotedId);
    if (!row?.id) return null;
    const quoted = await Message.findById(row.id);
    if (!quoted?.content) return null;
    return quoted.content.length > 80 ? `${quoted.content.substring(0, 80)}…` : quoted.content;
  } catch (_) {
    return null;
  }
}

async function processSingleMessage(message, value) {
  if (!message || !message.id || !message.from) return;

  // Deduplicate in-memory to avoid racing on bursts / Meta retries.
  if (processingIds.has(message.id)) return;
  processingIds.add(message.id);

  try {
    const alreadyProcessed = await Message.findByWaMessageId(message.id);
    if (alreadyProcessed) return;

    const phone = normalizePhone(message.from);
    const { normalized, text } = normalizeMessage(message, value);
    const remoteJid = normalized.key.remoteJid;
    const pushName = normalized.pushName;

    // If the message is a reply, prepend a preview of the quoted message.
    let finalText = text;
    const quotedId = message.context?.id;
    if (quotedId) {
      const qtext = await getQuotedContent(quotedId);
      if (qtext) {
        finalText = finalText
          ? `↩️ Resp. a: "${qtext}"\n${finalText}`
          : `↩️ Resp. a: "${qtext}"`;
        normalized.message.conversation = finalText;
      }
    }

    const msgTs = Number(message.timestamp || 0) * 1000;
    const isStale = msgTs > 0 && (Date.now() - msgTs) > 120000;
    const willRespond = !isStale && shouldBotRespond(phone);

    const tag = isStale ? '[OLD] ' : !shouldBotRespond(phone) ? '[MANUAL/INACTIVE] ' : '';
    console.log(`[WA Cloud] ${tag}Mensaje de ${phone}: ${finalText || '[media]'}`);

    let client = await Client.findByPhone(phone);
    if (pushName) {
      try {
        client = await Client.updateOrCreatePushName(phone, pushName);
      } catch (_) {}
    }

    let savedMedia = null;
    const mediaInfo = normalized.message.imageMessage
      || normalized.message.documentMessage
      || normalized.message.audioMessage
      || normalized.message.videoMessage;

    if (mediaInfo?.mediaId) {
      try {
        const mediaType = normalized.message.imageMessage ? 'image'
          : normalized.message.documentMessage ? 'document'
          : normalized.message.audioMessage ? 'audio'
          : 'video';
        const fileName = normalized.message.documentMessage?.fileName || undefined;
        const mediaResult = await saveCloudMedia(
          mediaInfo.mediaId,
          mediaInfo.mimetype,
          fileName,
          mediaType,
          phone,
          message.id
        );
        savedMedia = await ClientMedia.create({
          phone,
          clientId: client?.id || null,
          waMessageId: message.id,
          mediaType,
          mimeType: mediaResult.mimeType,
          originalName: fileName || mediaResult.fileName,
          savedName: mediaResult.savedName,
          filePath: mediaResult.filePath,
          fileSize: mediaResult.fileSize,
          context: 'conversation',
        });
      } catch (mediaErr) {
        console.error('[WA Cloud] Error saving media:', mediaErr.message);
      }
    }

    const hasMedia = !!savedMedia || !!mediaInfo;
    const mediaLabel = normalized.message.imageMessage ? 'foto'
      : normalized.message.documentMessage ? 'documento'
      : normalized.message.audioMessage ? 'audio'
      : normalized.message.videoMessage ? 'video' : 'archivo';
    const logContent = finalText
      ? (savedMedia ? `${finalText}\n[📎 adjunto]` : finalText)
      : (savedMedia ? `[📎 ${savedMedia.media_type || mediaLabel}]` : `[📎 ${mediaLabel}]`);

    try {
      await Message.create({
        waMessageId: message.id,
        phone,
        clientId: client?.id || null,
        direction: 'inbound',
        content: logContent,
        mediaUrl: savedMedia ? `/api/media/${savedMedia.id}/download` : null,
        waJid: remoteJid,
        pushName,
      });
      console.log(`[WA Cloud] ✅ Mensaje guardado en BD: inbound | phone=${phone} | jid=${remoteJid}`);
      if (client) {
        notifyNewMessage(client, phone, finalText).catch(() => {});
      }
    } catch (saveErr) {
      console.error(`[WA Cloud] ❌ Error guardando mensaje phone=${phone}:`, saveErr.message);
    }

    if (willRespond) {
      await handleResponse(phone, finalText, normalized, savedMedia, client);
    }
  } finally {
    processingIds.delete(message.id);
  }
}

async function processWebhookPayload(payload) {
  if (!payload || typeof payload !== 'object') return;

  const entries = payload.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};
      const messages = value.messages || [];
      for (const message of messages) {
        try {
          await processSingleMessage(message, value);
        } catch (err) {
          console.error('[WA Cloud] Error processing message:', err.message);
        }
      }
    }
  }
}

module.exports = {
  processWebhookPayload,
};
