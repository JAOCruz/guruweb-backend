// Lo que se "envía por WhatsApp" a un cliente del simulador del panel (teléfono sim_… / simulate_…) no sale a
// WhatsApp: queda como mensaje del bot en esa conversación del simulador, con el archivo guardado para verlo.
// Así se prueba de punta a punta (cotización aprobada → PDF en el chat) sin un número real.
const fs = require('fs');
const path = require('path');
const ClientMedia = require('../models/ClientMedia');
const SimulatorConversation = require('../models/SimulatorConversation');
const SimulatorMessage = require('../models/SimulatorMessage');

const fakeId = () => `sim_out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Misma forma que la respuesta de Baileys: el id del mensaje en key.id
async function send(phone, { text = '', filePath = null, fileName = null, mimeType = null, mediaType = 'document' } = {}) {
  const id = fakeId();
  const conversation = await SimulatorConversation.findBySession(String(phone));
  if (!conversation) return { key: { id } };
  let media = null;
  if (filePath) {
    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    media = await ClientMedia.create({
      phone: String(phone), clientId: null, waMessageId: id, mediaType, mimeType,
      originalName: fileName || path.basename(filePath), savedName: path.basename(filePath),
      filePath, fileSize: fs.statSync(filePath).size, context: 'simulator',
    });
  }
  await SimulatorMessage.create({
    conversationId: conversation.id, role: 'bot', text,
    mediaType: media ? mediaType : null,
    mediaOriginalName: media ? media.original_name : null,
    mediaAnalysis: media ? `Archivo enviado al cliente (id ${media.id})` : null,
  });
  return { key: { id } };
}

module.exports = { send };
