const pool = require('../../db/pool');
const { fold } = require('../text');
const { getBusinessInfo, isOpen } = require('../businessInfo');
const { assigneeOrAdmins, notifyUsers } = require('./notify');

const keyOf = (phone) => `handoff:${phone}`;
const isUrgent = (text) => /\burgente\b/.test(fold(text));

async function sendNotice({ phone, client, urgente, motivo }) {
  const nombre = client?.name || phone;
  const { recipients } = await assigneeOrAdmins(client?.assigned_to);
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
async function notifyUrgentAfterHandoff(phone, text, now = new Date()) {
  const { rows } = await pool.query('SELECT value FROM wa_bot_state WHERE key = $1', [keyOf(phone)]);
  const state = rows[0]?.value;
  if (!state || state.urgente_avisado || !isUrgent(text)) return false;
  const info = await getBusinessInfo();
  if (isOpen(now, info.horario)) return false;
  const c = await pool.query('SELECT * FROM clients WHERE phone = $1', [phone]);
  await sendNotice({ phone, client: c.rows[0] || null, urgente: true, motivo: state.motivo });
  await pool.query(
    `UPDATE wa_bot_state SET value = $2, updated_at = NOW() WHERE key = $1`,
    [keyOf(phone), JSON.stringify({ ...state, urgente_avisado: true })]);
  return true;
}

module.exports = { pasar_a_humano, notifyUrgentAfterHandoff };
