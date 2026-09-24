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

async function graphRequest(pathOrUrl, options = {}) {
  if (!isCloudEnabled()) {
    throw new Error('WhatsApp Cloud API is not configured');
  }

  const url = new URL(pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`);
  url.searchParams.set('access_token', config.wa.cloud.accessToken);

  const fetchOptions = {
    method: options.method || 'GET',
    headers: options.headers || {},
  };

  if (options.body) {
    fetchOptions.body = options.body;
  }

  const res = await fetch(url.toString(), fetchOptions);
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = { raw: text };
  }

  if (!res.ok) {
    const err = new Error(data?.error?.message || `Graph API ${res.status} error`);
    err.status = res.status;
    err.response = data;
    throw err;
  }

  return data;
}

async function sendTextMessage(phone, text) {
  const to = normalizePhone(phone);
  const data = await graphRequest(`/${config.wa.cloud.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text },
    }),
  });
  return { key: { id: data.messages?.[0]?.id } };
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
  const url = new URL(mediaUrl);
  url.searchParams.set('access_token', config.wa.cloud.accessToken);
  const res = await fetch(url.toString());
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
  uploadMedia,
  sendDocumentMessage,
  sendImageMessage,
  getMediaUrl,
  downloadMedia,
  getMimeFromPath,
};
