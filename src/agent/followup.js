// Seguimiento de cotizaciones (Leandro, 2026-10-27): si al cliente se le envió la cotización o la factura y
// pasa un día (business_info.seguimiento_cotizaciones.horas) sin que escriba ni pague, el bot le escribe una
// sola vez, en horario de atención, como lo hace Leandro. El mensaje queda en el chat (el bot lo ve en su
// contexto si el cliente responde) y se avisa a los admins. Lo arranca src/index.js (startFollowups).
// Solo se miran envíos de hasta 2 días después del plazo: nada viejo recibe un seguimiento de golpe.
// Cada factura se marca (followup_at) antes de enviar; si WhatsApp falla queda followup_error y no se reintenta.
const pool = require('../db/pool');
const Message = require('../models/Message');
const { getBusinessInfo, isOpen } = require('./businessInfo');
const { activeAdminIds, notifyUsers } = require('./tools/notify');
const { logActivity } = require('../services/activityLog');

const WINDOW_HOURS = 48;

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
  const info = await getBusinessInfo();
  const cfg = info.seguimiento_cotizaciones;
  if (!cfg || cfg.activo !== true) return { sent: 0, apagado: true };
  if (!isOpen(now, info.horario)) return { sent: 0, cerrado: true };
  const horas = Number(cfg.horas) > 0 ? Number(cfg.horas) : 24;
  const zona = info.horario?.zona || 'America/Santo_Domingo';

  const { rows } = await pool.query(
    `SELECT i.* FROM invoices i
     WHERE i.status = 'sent' AND i.client_phone IS NOT NULL AND i.followup_at IS NULL
       AND i.sent_at <= $1::timestamptz - make_interval(hours => $2)
       AND i.sent_at > $1::timestamptz - make_interval(hours => $2 + $3)
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.phone = i.client_phone AND m.direction = 'inbound' AND m.created_at > i.sent_at)
     ORDER BY i.sent_at`,
    [now, horas, WINDOW_HOURS]);

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
      summary: `El bot le dio seguimiento a ${label} de ${invoice.client_name || 'cliente sin nombre'} (sin respuesta en ${horas} h)`,
      details: { doc_number: invoice.doc_number, horas },
    }));
    await after('aviso', async () => notifyUsers(await activeAdminIds(), {
      type: 'delivery', title: `🔔 Seguimiento enviado: ${invoice.doc_number}`,
      message: `El cliente ${invoice.client_name || 'sin nombre'} no respondió a ${label} en ${horas} h; el bot le escribió para darle seguimiento.`,
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

module.exports = { processFollowups, followupText, startFollowups, _setSender };
