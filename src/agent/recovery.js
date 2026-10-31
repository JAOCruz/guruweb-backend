// Disculpa por demora (Jay, 2026-10-31): si el cliente escribió y el bot no le respondió en 30 minutos (se cayó
// WhatsApp, la IA o la clave), el bot retoma: vuelve a intentar la respuesta, empezando con una disculpa. Si la IA
// sigue sin responder, manda una disculpa fija. Avisa al equipo en la campana.
// Una vez por mensaje sin respuesta (wa_bot_state 'demora:<teléfono>'), de 7 a. m. a 9 p. m. en Santo Domingo,
// solo en chats que atiende el bot y dentro de las 24 h en que WhatsApp deja escribirle al cliente. No toca el
// simulador ni los mensajes viejos que llegan al reconectar (status 'old'). Lo arranca src/index.js cada 5 minutos.
const pool = require('../db/pool');
const Message = require('../models/Message');
const Client = require('../models/Client');
const { AI_DEFERRED } = require('./agent');
const { activeAdminIds, notifyUsers } = require('./tools/notify');

const ZONA = 'America/Santo_Domingo';
const DESDE = 7; // 7 a. m.
const HASTA = 21; // 9 p. m.
const VENTANA_HORAS = 23;
const PREFIX = 'Disculpe la demora en responderle 🙏';
const FIXED = `${PREFIX} Tuvimos un inconveniente con el sistema. Ya le avisé al equipo y le respondemos en breve.`;

// Minutos sin respuesta: BOT_DEMORA_MIN en Railway (30 por defecto)
function minutes() {
  const n = Number(String(process.env.BOT_DEMORA_MIN ?? '').trim() || NaN);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

function hourIn(now) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: ZONA, hour: 'numeric', hourCycle: 'h23' }).format(now));
}

// Dobles para pruebas: el envío, el agente y si el bot atiende el chat
let deps = null;
function _setDeps(d) { deps = d || null; }
function getDeps() {
  if (deps) return deps;
  const handler = require('../whatsapp/handler'); // perezoso: arrastra Baileys
  const { engineFor } = require('./engine');
  return {
    sender: require('../whatsapp/outgoing'),
    respond: require('./agent').respond,
    botOwns: (phone) => engineFor(phone) === 'agent' && handler.shouldBotRespond(phone) && !handler.hasPendingRetry(phone),
  };
}

async function claim(phone, inboundId) {
  const { rowCount } = await pool.query(
    `INSERT INTO wa_bot_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
     WHERE COALESCE((wa_bot_state.value->>'inbound_id')::bigint, 0) < $3`,
    [`demora:${phone}`, JSON.stringify({ inbound_id: inboundId }), inboundId]);
  return rowCount > 0;
}

async function processUnanswered(now = new Date()) {
  const h = hourIn(now);
  if (h < DESDE || h >= HASTA) return { sent: 0, fueraDeHora: true };
  const { sender, respond, botOwns } = getDeps();
  if (!sender.isAvailable()) return { sent: 0, sinConexion: true };
  const mins = minutes();

  // El último mensaje de cada chat de las últimas 23 h, si es del cliente y lleva más de `mins` sin respuesta
  const { rows } = await pool.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (phone) id, phone, direction, status, created_at FROM messages
       WHERE created_at > $1::timestamptz - make_interval(hours => $3) AND phone NOT LIKE 'sim\\_%' AND phone NOT LIKE 'simulate\\_%'
       ORDER BY phone, id DESC) last
     WHERE direction = 'inbound' AND COALESCE(status, '') <> 'old' AND created_at <= $1::timestamptz - make_interval(mins => $2)
     ORDER BY created_at`,
    [now, mins, VENTANA_HORAS]);

  let sent = 0;
  for (const last of rows) {
    const phone = last.phone;
    if (!botOwns(phone)) continue;
    if (!(await claim(phone, last.id))) continue;
    // Lo que el cliente escribió desde la última respuesta
    const { rows: pend } = await pool.query(
      `SELECT content FROM messages WHERE phone = $1 AND direction = 'inbound' AND id <= $2
         AND id > COALESCE((SELECT max(id) FROM messages WHERE phone = $1 AND direction = 'outbound'), 0)
       ORDER BY id`, [phone, last.id]);
    const text = pend.map((m) => m.content).join('\n');
    const target = (await Message.getLastJid(phone)) || phone;
    let delivered = false;
    const deliver = async (out) => {
      const body = out === FIXED ? out : `${PREFIX}\n\n${out}`;
      const result = await sender.sendText(target, body);
      delivered = true;
      const client = await Client.findByPhone(phone);
      const row = await Message.create({
        waMessageId: result?.key?.id || result?.messages?.[0]?.id || null, phone, clientId: client?.id || null,
        direction: 'outbound', content: body, waJid: String(target).includes('@') ? target : null,
      });
      return row?.id || null;
    };
    try {
      const reply = await respond(phone, text, { cutoff: last.id, shouldRun: () => botOwns(phone), deliver });
      if (reply === AI_DEFERRED) await deliver(FIXED);
    } catch (err) {
      console.error('[demora]', phone, err.code || err.message);
    }
    if (!delivered) continue;
    sent++;
    try {
      const client = await Client.findByPhone(phone);
      await notifyUsers(await activeAdminIds(), {
        type: 'delivery', title: `⏳ El bot tardó en responder: ${client?.name || phone}`,
        message: `El bot no le respondió por más de ${mins} minutos (falla de conexión o de la IA). Le pidió disculpas y retomó la conversación.`,
        link: `/bot-messages?phone=${encodeURIComponent(phone)}`, metadata: { phone, demora: true },
      });
    } catch (err) {
      console.error('[demora] aviso', phone, err.code || err.message);
    }
  }
  return { sent };
}

function startRecovery(intervalMs = 5 * 60 * 1000) {
  const run = () => processUnanswered().catch((err) => console.error('[demora] error:', err.code || err.message));
  return setInterval(run, intervalMs);
}

module.exports = { processUnanswered, startRecovery, PREFIX, FIXED, _setDeps };
