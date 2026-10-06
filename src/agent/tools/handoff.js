const pool = require('../../db/pool');
const { fold } = require('../text');
const { getBusinessInfo, isOpen } = require('../businessInfo');
const { assigneeOrAdmins, activeAdminIds, notifyUsers } = require('./notify');

const keyOf = (phone) => `handoff:${phone}`;
const isUrgent = (text) => /\burgente\b/.test(fold(text));

// Normal: el asignado (o, si no hay, los admins). Urgente: el asignado y además cada admin activo.
async function sendNotice({ phone, client, urgente, motivo }) {
  const nombre = client?.name || phone;
  let { recipients } = await assigneeOrAdmins(client?.assigned_to);
  if (urgente) recipients = [...new Set([...recipients, ...(await activeAdminIds())])];
  await notifyUsers(recipients, {
    type: 'handoff',
    title: `${urgente ? '🚨 URGENTE ' : ''}🙋 El bot pasó un chat: ${nombre}`,
    message: motivo ? String(motivo) : 'Un cliente necesita atención de una persona.',
    link: `/bot-messages?phone=${phone}`, metadata: { phone },
  });
}

// ctx.lastText: último texto del cliente (string, puede faltar); lo pone el bucle del agente.
async function pasar_a_humano(args, ctx) {
  const motivo = args && args.motivo ? String(args.motivo) : '';
  const now = ctx.now || new Date();
  const info = await getBusinessInfo();
  const urgente = !isOpen(now, info.horario) && isUrgent(ctx.lastText);

  require('../../whatsapp/handler').setManualMode(ctx.phone, true); // perezoso: evita require circular
  await pool.query(
    `INSERT INTO wa_bot_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [keyOf(ctx.phone), JSON.stringify({ at: now.toISOString(), motivo, urgente_avisado: urgente })]);
  await sendNotice({ phone: ctx.phone, client: ctx.client, urgente, motivo });
  return { mensaje: info.mensaje_espera, urgente };
}

// Chat ya en manual: si el cliente escribe "urgente" fuera de horario, avisa una sola vez.
// El "una sola vez" lo garantiza la base: un UPDATE atómico reclama el aviso y solo quien lo reclamó avisa
// (dos lotes a la vez no avisan dos veces).
async function notifyUrgentAfterHandoff(phone, text, now = new Date()) {
  if (!isUrgent(text)) return false;
  const info = await getBusinessInfo();
  if (isOpen(now, info.horario)) return false;
  const { rows } = await pool.query(
    `UPDATE wa_bot_state SET value = jsonb_set(value, '{urgente_avisado}', 'true'), updated_at = NOW()
     WHERE key = $1 AND COALESCE((value->>'urgente_avisado')::boolean, false) = false
     RETURNING value`, [keyOf(phone)]);
  if (!rows.length) return false; // sin traspaso del bot, o ya avisado
  const state = rows[0].value || {};
  const c = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone]);
  await sendNotice({ phone, client: c.rows[0] || null, urgente: true, motivo: state.motivo });
  return true;
}

module.exports = { pasar_a_humano, notifyUrgentAfterHandoff };
