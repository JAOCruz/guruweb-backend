// Chat asignado a una persona: el bot se calla y, si nadie responde en 20 minutos de horario, se avisa al admin.
const pool = require('../db/pool');
const { getBusinessInfo, isOpen } = require('../agent/businessInfo');
const { activeAdminIds, notifyUsers } = require('../agent/tools/notify');

const WAIT_MIN = 20;
const keyOf = (phone) => `assigned:${phone}`;

async function chatAssigned(phone, userId, now = new Date()) {
  if (!phone) return;
  require('../whatsapp/handler').setManualMode(phone, true); // perezoso: evita require circular
  await pool.query(
    `INSERT INTO wa_bot_state (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [keyOf(phone), JSON.stringify({ at: now.toISOString(), user_id: userId, avisado: false })]);
}

// El modo del bot no cambia: el admin lo vuelve a encender con el botón 🤖.
async function chatUnassigned(phone) {
  if (!phone) return;
  await pool.query('DELETE FROM wa_bot_state WHERE key = $1', [keyOf(phone)]);
}

// Minutos de horario de atención entre from y to (se detiene al llegar a `cap`).
function openMinutesBetween(from, to, horario, cap = WAIT_MIN) {
  let n = 0;
  for (let t = from.getTime(); t < to.getTime() && n < cap; t += 60000) {
    if (isOpen(new Date(t), horario)) n++;
  }
  return n;
}

// → cuántos avisos nuevos salieron.
async function checkUnattended(now = new Date()) {
  const info = await getBusinessInfo();
  if (!isOpen(now, info.horario)) return 0;
  const { rows } = await pool.query(
    `SELECT key, value FROM wa_bot_state WHERE key LIKE 'assigned:%' AND COALESCE((value->>'avisado')::boolean, false) = false`);
  let sent = 0;
  for (const { key, value } of rows) {
    const phone = key.slice('assigned:'.length);
    const at = new Date(value.at);
    if (openMinutesBetween(at, now, info.horario) < WAIT_MIN) continue;
    const c = await pool.query(
      `SELECT c.name, c.assigned_to, u.name AS user_name, u.username FROM clients c LEFT JOIN users u ON u.id = c.assigned_to WHERE c.phone = $1`, [phone]);
    const client = c.rows[0];
    if (!client || Number(client.assigned_to) !== Number(value.user_id)) continue;
    const replied = await pool.query(
      `SELECT 1 FROM messages WHERE phone = $1 AND direction = 'outbound' AND created_at > $2 LIMIT 1`, [phone, at]);
    if (replied.rows.length) continue;
    // Un solo aviso por asignación, aunque dos revisiones corran a la vez.
    const claim = await pool.query(
      `UPDATE wa_bot_state SET value = jsonb_set(value, '{avisado}', 'true'), updated_at = NOW()
       WHERE key = $1 AND COALESCE((value->>'avisado')::boolean, false) = false RETURNING key`, [key]);
    if (!claim.rows.length) continue;
    const who = client.user_name || client.username || 'el digitador';
    await notifyUsers(await activeAdminIds(), {
      type: 'unattended',
      title: `⏰ Chat sin atender: ${client.name || phone}`,
      message: `Asignado a ${who} hace ${WAIT_MIN} minutos y nadie ha respondido.`,
      link: `/bot-messages?phone=${phone}`,
      metadata: { phone, user_id: value.user_id },
    });
    sent++;
  }
  return sent;
}

function startUnattendedChecker(intervalMs = 60000) {
  const run = () => checkUnattended().catch((err) => console.error('[Asignación] revisión falló:', err.code || err.message));
  return setInterval(run, intervalMs);
}

module.exports = { chatAssigned, chatUnassigned, checkUnattended, startUnattendedChecker, WAIT_MIN };
