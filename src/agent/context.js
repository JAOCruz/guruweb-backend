// Contexto de cada turno: guía + datos del negocio + "Ahora" + ficha del cliente, y los últimos 30 mensajes.
// Los precios nunca van aquí: el modelo los consulta con herramientas.
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const Message = require('../models/Message');
const legalProfile = require('../documentos/legalProfile');
const { getBusinessInfo, isOpen, formatForPrompt } = require('./businessInfo');

const HISTORY_LIMIT = 30;
const ZONA = 'America/Santo_Domingo';
// Estados reales de `cases` (cases_status_check en migrations/20250716_case_certifications.sql).
// Cerrados: los que User.OPEN_CASE excluye (resolved/closed/paid/cancelled) más los finales del flujo de certificaciones.
const CLOSED_STATES = ['resolved', 'closed', 'paid', 'cancelled', 'completed', 'delivered', 'rejected'];
const ESTADO = {
  open: 'abierta', in_progress: 'en proceso', pending_payment: 'pendiente de pago', paid: 'pagada', resolved: 'resuelta',
  new: 'nueva', awaiting_institution: 'esperando a la institución', rejected: 'rechazada', completed: 'completada',
  delivered: 'entregada', closed: 'cerrada', cancelled: 'cancelada', escalated: 'escalada a una persona',
};

let guideCache = null;
function loadGuide() {
  if (guideCache === null) guideCache = fs.readFileSync(path.join(__dirname, 'guide.md'), 'utf8').trim();
  return guideCache;
}

function formatNow(now, zona = ZONA) {
  return new Intl.DateTimeFormat('es-DO', {
    timeZone: zona, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
}

const looksLikePhone = (n) => !n || /^[\d\s+()-]+$/.test(String(n).trim());

async function openRequests(clientId) {
  const { rows } = await pool.query(
    `SELECT case_number, title, status, updated_at FROM cases
     WHERE client_id = $1 AND COALESCE(status, '') <> ALL($2::text[])
     ORDER BY created_at DESC, id DESC LIMIT 5`, [clientId, CLOSED_STATES]);
  return rows;
}

async function clientSheet(client) {
  if (!client?.id) return 'Cliente nuevo: todavía no está registrado y no sabemos su nombre. Pídaselo con naturalidad.';
  const lines = [];
  lines.push(looksLikePhone(client.name)
    ? 'Nombre: no lo ha dado todavía (pídaselo con naturalidad).'
    : `Nombre: ${client.name}`);

  const profile = await legalProfile.get(client.id);
  const datos = Object.entries(profile)
    .filter(([k, v]) => legalProfile.norm(k) !== 'HISTORIAL' && v != null && String(v).trim() !== '' && typeof v !== 'object')
    .map(([k, v]) => `${legalProfile.norm(k)}: ${String(v).trim()}`);
  lines.push(datos.length ? `Datos en su ficha (no los vuelva a pedir, confírmelos si hace falta):\n- ${datos.join('\n- ')}`
    : 'Datos en su ficha: ninguno todavía.');

  const casos = await openRequests(client.id);
  lines.push(casos.length
    ? `Solicitudes abiertas:\n- ${casos.map((c) => `${c.case_number} — ${c.title} (${ESTADO[c.status] || c.status})`).join('\n- ')}`
    : 'Solicitudes abiertas: ninguna.');

  const mem = await pool.query('SELECT resumen FROM bot_memory WHERE client_id = $1', [client.id]);
  if (mem.rows[0]?.resumen) lines.push(`Resumen de conversaciones anteriores:\n${mem.rows[0].resumen}`);
  return lines.join('\n');
}

// cutoff: id del último inbound que forma parte del lote (lo fija el handler al cerrar el lote). Los inbound
// guardados después son de un lote siguiente y se responden en su propio turno, no en este. Los outbound
// no se filtran: la respuesta del turno anterior, entregada mientras este esperaba su turno, sí es contexto.
async function recentMessages(phone, cutoff = null) {
  const rows = cutoff == null
    ? await Message.findRecentByPhone(phone, HISTORY_LIMIT)
    : (await pool.query(
      `SELECT direction, content FROM messages
       WHERE phone = $1 AND (direction <> 'inbound' OR id <= $2)
       ORDER BY created_at DESC, id DESC LIMIT $3`, [phone, Number(cutoff), HISTORY_LIMIT])).rows.reverse();
  return rows
    .filter((m) => m.content && String(m.content).trim())
    .map((m) => ({ role: m.direction === 'outbound' ? 'assistant' : 'user', text: String(m.content) }));
}

async function buildContext({ phone, client, now = new Date(), cutoff = null }) {
  const info = await getBusinessInfo();
  const zona = info.horario?.zona || ZONA;
  const abierto = isOpen(now, info.horario);
  const negocio = [formatForPrompt(info)];
  if (Array.isArray(info.temas_humano) && info.temas_humano.length) {
    negocio.push(`Temas que pasan a una persona (pasar_a_humano): ${info.temas_humano.join(', ')}.`);
  }
  const system = [
    loadGuide(),
    '---',
    '## Datos del negocio',
    negocio.join('\n'),
    `Ahora: ${formatNow(now, zona)} (${abierto ? 'abierto' : 'cerrado'})`,
    '---',
    '## Ficha del cliente',
    await clientSheet(client),
  ].join('\n\n');
  const messages = await recentMessages(phone, cutoff);
  return { system, messages };
}

module.exports = { buildContext, loadGuide, formatNow, CLOSED_STATES, ESTADO };
