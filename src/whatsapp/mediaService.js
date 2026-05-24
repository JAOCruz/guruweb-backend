const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const path = require('path');
const fs = require('fs');
const config = require('../config');

// Mime type to file extension mapping
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
};

function getExtension(mimeType, fileName) {
  if (fileName) {
    const ext = path.extname(fileName);
    if (ext) return ext;
  }
  return MIME_EXTENSIONS[mimeType] || '.bin';
}

/**
 * Download and save media from a WhatsApp message.
 * Returns { filePath, fileName, savedName, mimeType, mediaType, fileSize } or null.
 */
async function saveMediaFromMessage(msg, phone) {
  const mediaMessage = msg.message?.imageMessage
    || msg.message?.documentMessage
    || msg.message?.audioMessage
    || msg.message?.videoMessage;

  if (!mediaMessage) return null;

  const mimeType = mediaMessage.mimetype || 'application/octet-stream';
  const originalName = mediaMessage.fileName || null;
  const ext = getExtension(mimeType, originalName);
  const timestamp = Date.now();
  const waId = msg.key.id || 'unknown';
  const savedName = `${timestamp}_${waId}${ext}`;

  const mediaType = msg.message.imageMessage ? 'image'
    : msg.message.documentMessage ? 'document'
    : msg.message.audioMessage ? 'audio'
    : 'video';

  // Ensure directory exists: uploads/<phone>/
  const uploadsDir = config.uploads?.dir || './uploads';
  const phoneDir = path.join(uploadsDir, phone);
  fs.mkdirSync(phoneDir, { recursive: true });

  const filePath = path.join(phoneDir, savedName);

  // Download the media buffer from WhatsApp servers
  const buffer = await downloadMediaMessage(msg, 'buffer', {});

  // Check file size
  const maxSizeMB = config.uploads?.maxSizeMB || 25;
  const fileSizeMB = buffer.length / (1024 * 1024);
  if (fileSizeMB > maxSizeMB) {
    console.warn(`[Media] File too large (${fileSizeMB.toFixed(1)}MB) from ${phone}, skipping`);
    return null;
  }

  fs.writeFileSync(filePath, buffer);

  console.log(`[Media] Saved ${mediaType} from ${phone}: ${savedName} (${(buffer.length / 1024).toFixed(1)}KB)`);

  return {
    filePath,
    fileName: originalName || savedName,
    savedName,
    mimeType,
    mediaType,
    fileSize: buffer.length,
  };
}

module.exports = { saveMediaFromMessage };
