// El simulador del panel habla con el mismo agente que WhatsApp (Jay, 2026-10-31: probar con el panel como
// cliente). El chat queda en messages como el de un cliente real, así las cotizaciones y los documentos del bot
// salen por aprobar en el panel; lo que luego se "envía por WhatsApp" vuelve al simulador (whatsapp/simulatorOutbox).
const pool = require('../db/pool');
const Message = require('../models/Message');
const Client = require('../models/Client');
const { respond, AI_DEFERRED } = require('./agent');
const { notifyUrgentAfterHandoff, URGENT_ACK } = require('./tools/handoff');

const DEFERRED_TEXT = '🦉 (La IA no tiene cuota en este momento. En WhatsApp el cliente recibiría la respuesta en unos minutos.)';
const MANUAL_TEXT = '(El chat está con una persona: el bot no responde. Devuélvalo al bot en Mensajes para seguir probando.)';

// Perezoso: el handler arrastra Baileys
const isManual = (phone) => require('../whatsapp/handler').isManualMode(phone);

const AUDIO_PREFIX = /^TRANSCRIPCI[ÓO]N DE AUDIO:\s*/i;

// savedMedia: el que arma la ruta del simulador ({ id, mediaType, analysis }), ya analizado.
function mediaItem(savedMedia) {
  if (!savedMedia) return null;
  if (savedMedia.mediaType === 'audio') {
    return { id: savedMedia.id, media_type: 'audio', transcription: String(savedMedia.analysis || '').replace(AUDIO_PREFIX, '') };
  }
  return { id: savedMedia.id, media_type: savedMedia.mediaType, analysis: savedMedia.analysis || null };
}

function inboundContent(text, media) {
  if (!media) return text || '[mensaje]';
  const label = media.transcription
    ? `[🎤 Voz transcrita]: ${media.transcription}`
    : `[📷 ${media.media_type === 'document' ? 'Documento' : 'Imagen'} analizada]:\n${media.analysis || ''}`;
  return [text, '[📎 adjunto]', label].filter(Boolean).join('\n');
}

/**
 * Un turno del simulador con el agente. Devuelve el texto para mostrar en el chat del simulador.
 * @param {string} phone id de la sesión del simulador (sim_…)
 * @param {string} text
 * @param {object|null} savedMedia
 * @param {object} [opts] { provider } solo para pruebas
 */
async function simulatorTurn(phone, text, savedMedia = null, opts = {}) {
  const media = mediaItem(savedMedia);
  const client = await Client.findByPhone(phone);
  await Message.create({
    waMessageId: `sim_in_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    phone, clientId: client?.id || null, direction: 'inbound', content: inboundContent(text, media),
    mediaUrl: media ? `/api/media/${media.id}/download` : null,
  });
  const { rows } = await pool.query(`SELECT max(id) AS id FROM messages WHERE phone = $1 AND direction = 'inbound'`, [phone]);
  const reply = await respond(phone, text, {
    ...opts,
    media: media ? [media] : [],
    cutoff: rows[0]?.id ?? null,
    shouldRun: () => !isManual(phone),
    deliver: async (out) => {
      const c = await Client.findByPhone(phone); // una herramienta pudo registrarlo durante el turno
      const row = await Message.create({ phone, clientId: c?.id || null, direction: 'outbound', content: out });
      return row?.id || null;
    },
  });
  if (reply === AI_DEFERRED) return DEFERRED_TEXT;
  if (reply) return reply;
  // Como en WhatsApp: con el chat en una persona, el primer "urgente" fuera de horario avisa y se confirma
  if (isManual(phone) && await notifyUrgentAfterHandoff(phone, text)) return URGENT_ACK;
  return MANUAL_TEXT;
}

module.exports = { simulatorTurn, DEFERRED_TEXT, MANUAL_TEXT };
