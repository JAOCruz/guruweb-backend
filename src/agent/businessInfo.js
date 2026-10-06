const pool = require('../db/pool');

const TTL_MS = 60 * 1000;
let cache = null;
let cachedAt = 0;

async function getBusinessInfo() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;
  const { rows } = await pool.query('SELECT clave, valor FROM business_info');
  const info = {};
  for (const r of rows) info[r.clave] = r.valor;
  cache = info;
  cachedAt = Date.now();
  return info;
}

function clearCache() {
  cache = null;
  cachedAt = 0;
}

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

// Abre inclusivo, cierra exclusivo, evaluado en la zona del horario.
function isOpen(date, horario) {
  if (!horario) return false;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: horario.zona || 'America/Santo_Domingo',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t).value;
  const day = WEEKDAYS[get('weekday')];
  if (!(horario.dias || []).includes(day)) return false;
  const mins = Number(get('hour')) * 60 + Number(get('minute'));
  return mins >= toMinutes(horario.abre) && mins < toMinutes(horario.cierra);
}

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

function fmtHora(hhmm) {
  const [h, m] = String(hhmm).split(':');
  return `${Number(h)}:${m || '00'}`;
}

function formatDias(dias = []) {
  const d = [...dias].sort((a, b) => a - b);
  if (!d.length) return '';
  const consecutive = d.every((v, i) => i === 0 || v === d[i - 1] + 1);
  if (consecutive && d.length > 1) return `${DIAS[d[0]]} a ${DIAS[d[d.length - 1]]}`;
  return d.map((x) => DIAS[x]).join(', ');
}

function formatForPrompt(info = {}) {
  const lines = [];
  const h = info.horario;
  if (h) lines.push(`Horario de atención: ${formatDias(h.dias)}, de ${fmtHora(h.abre)} a ${fmtHora(h.cierra)} hrs (hora de República Dominicana).`);
  if (info.direccion) lines.push(`Dirección: ${info.direccion}.`);
  if (Array.isArray(info.formas_pago) && info.formas_pago.length) lines.push(`Formas de pago: ${info.formas_pago.join(' o ')}.`);
  if (info.entregas) lines.push(`Entregas: ${info.entregas}.`);
  return lines.join('\n');
}

module.exports = { getBusinessInfo, isOpen, formatForPrompt, clearCache };
