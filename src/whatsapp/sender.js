/**
 * WhatsApp file/document sender utility
 * Used by document generation flow to send generated .docx files
 */

const fs = require('fs');
const path = require('path');
const { getAnyConnection } = require('./connection');

/**
 * Send a document file to a WhatsApp chat
 */
async function sendDocumentToChat(jid, filePath, fileName) {
  try {
    const connection = await getAnyConnection();
    if (!connection) throw new Error('No active WhatsApp connection');
    const sock = connection.sock;

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileBuffer = fs.readFileSync(filePath);
    const baseFileName = fileName || path.basename(filePath);

    console.log(`[Sender] 📤 Sending PDF ${baseFileName} (${(fileBuffer.length/1024).toFixed(2)} KB) to ${jid}`);

    // Send a text message first to ensure connection is stable
    await sock.sendMessage(jid, { text: '📄 Adjuntando su factura...' });

    // Small delay to ensure connection stability
    await new Promise(r => setTimeout(r, 500));

    // Then send the document
    const result = await sock.sendMessage(jid, {
      document: fileBuffer,
      fileName: baseFileName,
      mimetype: 'application/pdf',
    });

    console.log(`[Sender] ✅ PDF sent to ${jid}: ${baseFileName}`);
    return true;
  } catch (err) {
    console.error(`[Sender] ❌ Failed to send document:`, err.message);
    throw err;
  }
}

/**
 * Send an image file to a WhatsApp chat
 */
async function sendImageToChat(jid, filePath, caption = '') {
  const sock = await getAnyConnection();
  if (!sock) throw new Error('No active WhatsApp connection');

  const fileBuffer = fs.readFileSync(filePath);
  await sock.sendMessage(jid, {
    image: fileBuffer,
    caption,
  });
}

module.exports = { sendDocumentToChat, sendImageToChat };
