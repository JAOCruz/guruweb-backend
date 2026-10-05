const fs = require('fs');
const path = require('path');
const config = require('../config');

const GRAPH_BASE = `https://graph.facebook.com/${config.wa.cloud.apiVersion}`;

function isCloudEnabled() {
  return !!(config.wa.cloud.accessToken && config.wa.cloud.phoneNumberId);
}

function getExtension(mimeType, fileName) {
  if (fileName) {
    const ext = path.extname(fileName);
    if (ext) return ext;
  }
  const map = {
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
  return map[mimeType] || '.bin';
}

function getMimeFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg; codecs=opus',
    '.mp4': 'video/mp4',
    '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

function normalizePhone(input) {
  return String(input).replace(/\D/g, '');
}

const authHeader = () => ({ Authorization: `Bearer ${config.wa.cloud.accessToken}` });

// Meta's error codes worth explaining to whoever is sending from the dashboard
const WINDOW_CLOSED_CODES = new Set([131047, 131026]);

async function graphRequest(pathOrUrl, options = {}) {
  if (!isCloudEnabled()) {
    throw new Error('WhatsApp Cloud API is not configured');
  }

  // the token goes in the header: a URL ends up in proxy and error logs
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;

  const fetchOptions = {
    method: options.method || 'GET',
    headers: { ...(options.headers || {}), ...authHeader() },
  };

  if (options.body) {
    fetchOptions.body = options.body;
  }

  const res = await fetch(url, fetchOptions);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }

  if (!res.ok) {
    const metaCode = data?.error?.code;
    const err = WINDOW_CLOSED_CODES.has(metaCode)
      ? new Error('Pasaron más de 24 horas desde el último mensaje del cliente: WhatsApp solo permite escribirle con una plantilla aprobada')
      : new Error(data?.error?.message || `Graph API ${res.status} error`);
    if (WINDOW_CLOSED_CODES.has(metaCode)) err.code = 'WINDOW_CLOSED';
    err.status = res.status;
    err.metaCode = metaCode;
    err.response = data;
    throw err;
  }

  return data;
}

const MAX_TEXT = 4096;

// WhatsApp caps a text message at 4096 characters: cut at a paragraph or line break when possible
function splitText(text) {
  const parts = [];
  let rest = String(text);
  while (rest.length > MAX_TEXT) {
    const window = rest.slice(0, MAX_TEXT);
    let cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('\n'));
    if (cut < MAX_TEXT / 2) cut = window.lastIndexOf(' ');
    if (cut < MAX_TEXT / 2) cut = MAX_TEXT;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function sendTextMessage(phone, text) {
  const to = normalizePhone(phone);
  let first = null;
  for (const body of splitText(text)) {
    const data = await graphRequest(`/${config.wa.cloud.phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body },
      }),
    });
    if (!first) first = data;
  }
  return { key: { id: first?.messages?.[0]?.id } };
}

// The client sees the blue ticks: only called when the bot is the one answering
async function markAsRead(messageId) {
  return graphRequest(`/${config.wa.cloud.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
  });
}

async function uploadMedia(buffer, mimeType, fileName) {
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  const blob = new Blob([buffer], { type: mimeType });
  form.append('file', blob, fileName || `file${getExtension(mimeType, fileName)}`);

  const data = await graphRequest(`/${config.wa.cloud.phoneNumberId}/media`, {
    method: 'POST',
    body: form,
  });
  return { id: data.id };
}

async function sendDocumentMessage(phone, filePath, fileName, caption = '') {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const buffer = fs.readFileSync(filePath);
  const mimeType = getMimeFromPath(filePath);
  const baseFileName = fileName || path.basename(filePath);
  const { id: mediaId } = await uploadMedia(buffer, mimeType, baseFileName);

  const to = normalizePhone(phone);
  const data = await graphRequest(`/${config.wa.cloud.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'document',
      document: {
        id: mediaId,
        caption: caption || undefined,
        filename: baseFileName,
      },
    }),
  });
  return { key: { id: data.messages?.[0]?.id } };
}

async function sendImageMessage(phone, filePathOrUrl, caption = '') {
  const to = normalizePhone(phone);
  const isUrl = /^https?:\/\//i.test(filePathOrUrl);

  let imagePayload;
  if (isUrl) {
    imagePayload = { link: filePathOrUrl, caption: caption || undefined };
  } else {
    if (!fs.existsSync(filePathOrUrl)) {
      throw new Error(`File not found: ${filePathOrUrl}`);
    }
    const buffer = fs.readFileSync(filePathOrUrl);
    const mimeType = getMimeFromPath(filePathOrUrl);
    const { id: mediaId } = await uploadMedia(buffer, mimeType, path.basename(filePathOrUrl));
    imagePayload = { id: mediaId, caption: caption || undefined };
  }

  const data = await graphRequest(`/${config.wa.cloud.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'image',
      image: imagePayload,
    }),
  });
  return { key: { id: data.messages?.[0]?.id } };
}

async function getMediaUrl(mediaId) {
  const data = await graphRequest(`/${mediaId}`);
  return {
    url: data.url,
    mime_type: data.mime_type,
    file_size: data.file_size,
  };
}

async function downloadMedia(mediaUrl) {
  const res = await fetch(mediaUrl, { headers: authHeader() });
  if (!res.ok) {
    throw new Error(`Media download failed: ${res.status}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

module.exports = {
  isCloudEnabled,
  graphRequest,
  sendTextMessage,
  markAsRead,
  uploadMedia,
  sendDocumentMessage,
  sendImageMessage,
  getMediaUrl,
  downloadMedia,
  getMimeFromPath,
};
