/**
 * WhatsApp file/document sender utility
 * Used by document generation flow to send generated .docx / PDF files.
 * Delegates to the unified outgoing layer so it works with both Baileys and Cloud API.
 */

const { sendDocument, sendImage } = require('./outgoing');

/**
 * Send a document file to a WhatsApp chat
 */
async function sendDocumentToChat(jid, filePath, fileName) {
  try {
    const baseFileName = fileName || require('path').basename(filePath);
    console.log(`[Sender] 📤 Sending document ${baseFileName} to ${jid}`);

    const result = await sendDocument(jid, filePath, baseFileName);

    console.log(`[Sender] ✅ Document sent to ${jid}: ${baseFileName}`);
    return result;
  } catch (err) {
    console.error(`[Sender] ❌ Failed to send document:`, err.message);
    throw err;
  }
}

/**
 * Send an image file to a WhatsApp chat
 */
async function sendImageToChat(jid, filePath, caption = '') {
  return sendImage(jid, filePath, caption);
}

module.exports = { sendDocumentToChat, sendImageToChat };
