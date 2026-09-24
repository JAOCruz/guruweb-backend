const fs = require('fs');
const path = require('path');
const cloudApi = require('./cloudApi');
const { getAnyConnection, sendMessage } = require('./connection');

function isCloudEnabled() {
  return cloudApi.isCloudEnabled();
}

function toCloudPhone(input) {
  return String(input).replace(/\D/g, '');
}

function toBaileysJid(input) {
  const s = String(input);
  if (s.includes('@')) return s;
  return `${s.replace(/\D/g, '')}@s.whatsapp.net`;
}

function isUrl(str) {
  return /^https?:\/\//i.test(str);
}

function isAvailable() {
  if (cloudApi.isCloudEnabled()) return true;
  return !!getAnyConnection();
}

async function sendText(phoneOrJid, text) {
  if (cloudApi.isCloudEnabled()) {
    return cloudApi.sendTextMessage(toCloudPhone(phoneOrJid), text);
  }

  const conn = getAnyConnection();
  if (!conn) throw new Error('No active WhatsApp connection');
  const jid = toBaileysJid(phoneOrJid);
  return sendMessage(conn.sessionId, jid, { text });
}

async function sendDocument(phoneOrJid, filePath, fileName, caption = '') {
  if (cloudApi.isCloudEnabled()) {
    return cloudApi.sendDocumentMessage(toCloudPhone(phoneOrJid), filePath, fileName, caption);
  }

  const conn = getAnyConnection();
  if (!conn) throw new Error('No active WhatsApp connection');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const buffer = fs.readFileSync(filePath);
  const jid = toBaileysJid(phoneOrJid);
  const baseFileName = fileName || path.basename(filePath);
  return sendMessage(conn.sessionId, jid, {
    document: buffer,
    fileName: baseFileName,
    mimetype: cloudApi.getMimeFromPath(filePath),
    caption: caption || undefined,
  });
}

async function sendImage(phoneOrJid, filePathOrUrl, caption = '') {
  if (cloudApi.isCloudEnabled()) {
    return cloudApi.sendImageMessage(toCloudPhone(phoneOrJid), filePathOrUrl, caption);
  }

  const conn = getAnyConnection();
  if (!conn) throw new Error('No active WhatsApp connection');
  const jid = toBaileysJid(phoneOrJid);

  if (isUrl(filePathOrUrl)) {
    return sendMessage(conn.sessionId, jid, { image: { url: filePathOrUrl }, caption: caption || undefined });
  }

  if (!fs.existsSync(filePathOrUrl)) throw new Error(`File not found: ${filePathOrUrl}`);
  const buffer = fs.readFileSync(filePathOrUrl);
  return sendMessage(conn.sessionId, jid, { image: buffer, caption: caption || undefined });
}

async function sendMedia(phoneOrJid, filePath, { mimeType, fileName, caption = '', mediaType }) {
  if (cloudApi.isCloudEnabled()) {
    // Cloud API natively supports image messages; everything else is sent as a document attachment.
    if (mediaType === 'image') {
      return cloudApi.sendImageMessage(toCloudPhone(phoneOrJid), filePath, caption);
    }
    return cloudApi.sendDocumentMessage(toCloudPhone(phoneOrJid), filePath, fileName || path.basename(filePath), caption);
  }

  const conn = getAnyConnection();
  if (!conn) throw new Error('No active WhatsApp connection');
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const jid = toBaileysJid(phoneOrJid);
  const buffer = fs.readFileSync(filePath);
  const baseFileName = fileName || path.basename(filePath);
  const payload = { caption: caption || undefined };

  if (mediaType === 'image') {
    payload.image = buffer;
  } else if (mediaType === 'video') {
    payload.video = buffer;
  } else if (mediaType === 'audio') {
    payload.audio = buffer;
    payload.mimetype = mimeType || 'audio/mpeg';
    payload.ptt = false;
  } else {
    payload.document = buffer;
    payload.fileName = baseFileName;
    payload.mimetype = mimeType || cloudApi.getMimeFromPath(filePath);
  }

  return sendMessage(conn.sessionId, jid, payload);
}

module.exports = {
  isAvailable,
  isCloudEnabled,
  sendText,
  sendDocument,
  sendImage,
  sendMedia,
};
