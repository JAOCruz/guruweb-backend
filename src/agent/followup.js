// Seguimiento de cotizaciones (Leandro, 2026-10-27): si al cliente se le envió la cotización o la factura y no
// contesta, el bot le escribe una sola vez, en horario de atención, como lo hace Leandro. El mensaje queda en el
// chat (el bot lo ve en su contexto si el cliente responde) y se avisa a los admins. Lo arranca src/index.js.
// Jay, 2026-11-27: Meta solo deja escribirle al cliente hasta 24 h después de SU último mensaje. Por eso el
// seguimiento sale a las `horas` (22 como máximo) de ese mensaje y, pasadas 23 h, ya no se intenta (nada de
// «No enviado»). Hay interruptor general (business_info.seguimiento_cotizaciones.activo) y por cliente
// (clients.followup_off), y solo va a los chats que atiende el bot: los de los digitadores no se tocan.
// Cada factura se marca (followup_at) antes de enviar; si WhatsApp falla queda followup_error y no se reintenta.
const pool = require('../db/pool');
const Message = require('../models/Message');
const { getBusinessInfo, isOpen } = require('./businessInfo');
const { activeAdminIds, notifyUsers } = require('./tools/notify');
const { logActivity } = require('../services/activityLog');
const { botForzadoApagado } = require('../whatsapp/forzarApagado');

const MAX_HOURS = 22; // a las 22 h del último mensaje del cliente, dentro de las 24 h de Meta
const WINDOW_LIMIT_HOURS = 23; // después de esto ya no se intenta
const MIN_AFTER_SEND_HOURS = 1; // nunca justo después de mandar la cotización

// Dobles para pruebas: si el bot atiende ese chat
let deps = null;
function _setDeps(d) { deps = d || null; }
function botOwns(phone) {
  if (deps?.botOwns) return deps.botOwns(phone);
  const handler = require('../whatsapp/handler'); // perezoso: arrastra Baileys
  const { engineFor } = require('./engine');
  return engineFor(phone) === 'agent' && handler.shouldBotRespond(phone);
}

let sender = null;
function getSender() {
  if (!sender) sender = require('../whatsapp/outgoing'); // perezoso: arrastra Baileys
  return sender;
}
function _setSender(s) { sender = s || null; }

function greeting(now, zona) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: zona, hour: 'numeric', hourCycle: 'h23' }).format(now));
  return h < 12 ? 'días' : h < 19 ? 'tardes' : 'noches';
}

function followupText(invoice, now, zona) {
  const hola = `Saludos y muy buenas ${greeting(now, zona)}!! 🦉\n\n¿Cómo está todo? `;
  if (invoice.type === 'FACTURA') {
    return `${hola}Le escribimos para darle seguimiento a su factura ${invoice.doc_number}, que tiene un pago pendiente. `
      + '¿Pudo realizarlo? Si ya lo hizo, compártanos el comprobante por aquí y con gusto continuamos.';
  }
  return `${hola}Le escribimos para darle seguimiento a la cotización ${invoice.doc_number} que le enviamos. `
    + '¿Pudo revisarla? Si desea seguir adelante o tiene alguna pregunta, con gusto le ayudamos.';
}

async function processFollowups(now = new Date()) {
  if (botForzadoApagado()) return { sent: 0, apagado: true };
  const info = await getBusinessInfo();
  const cfg = info.seguimiento_cotizaciones;
  if (!cfg || cfg.activo !== true) return { sent: 0, apagado: true };
  if (!isOpen(now, info.horario)) return { sent: 0, cerrado: true };
  const pedidas = Number(cfg.horas) > 0 ? Number(cfg.horas) : MAX_HOURS;
  const horas = Math.min(pedidas, MAX_HOURS);
  const zona = info.horario?.zona || 'America/Santo_Domingo';

  // The client's last message opens Meta's 24 h window; it must be before the quote (no reply since)
  const { rows: candidates } = await pool.query(
    `SELECT i.* FROM invoices i
     LEFT JOIN clients c ON c.id = i.client_id
     CROSS JOIN LATERAL (SELECT MAX(m.created_at) AS last_in FROM messages m
                         WHERE m.phone = i.client_phone AND m.direction = 'inbound') li
     WHERE i.status = 'sent' AND i.client_phone IS NOT NULL AND i.followup_at IS NULL AND i.sent_at IS NOT NULL
       AND COALESCE(c.followup_off, false) = false
       AND i.sent_at <= $1::timestamptz - make_interval(hours => $4)
       AND li.last_in IS NOT NULL AND li.last_in <= i.sent_at
       AND li.last_in <= $1::timestamptz - make_interval(hours => $2)
       AND li.last_in > $1::timestamptz - make_interval(hours => $3)
     ORDER BY i.sent_at`,
    [now, horas, WINDOW_LIMIT_HOURS, MIN_AFTER_SEND_HOURS]);
  const rows = candidates.filter((inv) => botOwns(inv.client_phone));

  let sent = 0;
  for (const invoice of rows) {
    const claimed = await pool.query('UPDATE invoices SET followup_at = $2 WHERE id = $1 AND followup_at IS NULL RETURNING id', [invoice.id, now]);
    if (!claimed.rowCount) continue;
    const text = followupText(invoice, now, zona);
    const target = (await Message.getLastJid(invoice.client_phone)) || invoice.client_phone;
    let result;
    try {
      result = await getSender().sendText(target, text);
    } catch (err) {
      const code = err && err.code === 'WINDOW_CLOSED' ? 'WINDOW_CLOSED' : 'SEND_FAILED';
      await pool.query('UPDATE invoices SET followup_error = $2 WHERE id = $1', [invoice.id, code]);
      console.error('[seguimiento]', invoice.id, code);
      continue;
    }
    sent++;
    const label = `${invoice.type === 'FACTURA' ? 'la factura' : 'la cotización'} ${invoice.doc_number}`;
    // el envío ya salió: el registro nunca lo deshace
    const after = async (step, fn) => {
      try { await fn(); } catch (err) { console.error('[seguimiento]', invoice.id, step, err.code || 'ERROR'); }
    };
    await after('mensaje', () => Message.create({
      waMessageId: result?.key?.id || result?.messages?.[0]?.id || null, phone: invoice.client_phone, clientId: invoice.client_id,
      direction: 'outbound', content: text, waJid: String(target).includes('@') ? target : null,
    }));
    await after('actividad', () => logActivity(null, {
      actor: null, category: 'facturas', action: 'invoice.followup', entityType: 'invoice', entityId: invoice.id,
      summary: `El bot le dio seguimiento a ${label} de ${invoice.client_name || 'cliente sin nombre'} (${horas} h después de su último mensaje, sin respuesta)`,
      details: { doc_number: invoice.doc_number, horas },
    }));
    await after('aviso', async () => notifyUsers(await activeAdminIds(), {
      type: 'delivery', title: `🔔 Seguimiento enviado: ${invoice.doc_number}`,
      message: `El cliente ${invoice.client_name || 'sin nombre'} no respondió a ${label}; a las ${horas} h de su último mensaje el bot le escribió para darle seguimiento.`,
      link: `/cotizaciones?invoice=${invoice.id}`, metadata: { invoice_id: invoice.id, doc_number: invoice.doc_number, followup: true },
    }));
  }
  return { sent };
}

// Lo arranca src/index.js (el punto de entrada real) cada 10 minutos
function startFollowups(intervalMs = 10 * 60 * 1000) {
  const run = () => processFollowups().catch((err) => console.error('[seguimiento] error:', err.code || err.message));
  return setInterval(run, intervalMs);
}

module.exports = { processFollowups, followupText, startFollowups, _setSender, _setDeps };
