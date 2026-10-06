// Memoria por cliente: un resumen corto de lo hablado y lo pendiente (bot_memory), hecho al retomar
// una conversación que quedó quieta. Nunca bloquea el turno: cualquier error se ignora.
const pool = require('../db/pool');

const QUIET_MS = 30 * 60 * 1000;      // la conversación anterior quedó quieta este tiempo
const CURRENT_TURN_MS = 2 * 60 * 1000; // los inbound de los últimos 2 min son el turno actual, no se resumen
const MAX_MESSAGES = 80;
const TIMEOUT_MS = 12000;

const SYSTEM = 'Resume en español, en cinco líneas como máximo, la conversación entre un cliente y el asistente de ' +
  'Gurú Soluciones (documentos legales y trámites). Diga qué pidió el cliente, qué se acordó y qué quedó pendiente. ' +
  'No incluya números de cédula, pasaporte, teléfono ni montos de dinero. Si hay un resumen anterior, intégrelo. ' +
  'Responda solo con el resumen, sin título ni comentarios.';

// Por si el modelo los escribe igual: el resumen va al contexto y ahí no entran precios ni cédulas.
function scrub(text) {
  return String(text)
    .replace(/\b\d{3}-?\d{7}-?\d\b/g, '[cédula]')
    .replace(/RD\$\s?[\d.,]+|US\$\s?[\d.,]+|\$\s?[\d.,]+|\b\d[\d.,]*\s*(?:pesos|dólares)\b/gi, '[monto]')
    .trim();
}

async function maybeSummarize({ phone, client, provider, now = new Date() }) {
  try {
    if (!phone || !client?.id || !provider) return false;
    const { rows } = await pool.query(
      `SELECT id, direction, content, created_at FROM messages WHERE phone = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
      [phone, MAX_MESSAGES]);
    const nowMs = now.getTime();
    // El último mensaje anterior al turno: se saltan los inbound recién llegados (el lote actual).
    const prev = rows.find((r) => !(r.direction === 'inbound' && nowMs - new Date(r.created_at).getTime() < CURRENT_TURN_MS));
    if (!prev || nowMs - new Date(prev.created_at).getTime() < QUIET_MS) return false;

    const mem = (await pool.query('SELECT resumen, hasta_mensaje_id FROM bot_memory WHERE client_id = $1', [client.id])).rows[0];
    const since = mem?.hasta_mensaje_id || 0;
    const nuevos = rows.filter((r) => r.id > since && r.id <= prev.id).reverse();
    if (!nuevos.length) return false;

    const transcript = nuevos.map((r) => `${r.direction === 'inbound' ? 'Cliente' : 'Gurú'}: ${r.content}`).join('\n');
    const text = (mem?.resumen ? `Resumen anterior:\n${mem.resumen}\n\n` : '') + `Conversación:\n${transcript}`;
    const out = await provider.chat({ system: SYSTEM, messages: [{ role: 'user', text }], tools: [], timeoutMs: TIMEOUT_MS });
    const resumen = scrub(out?.text || '');
    if (!resumen) return false;

    await pool.query(
      `INSERT INTO bot_memory (client_id, resumen, hasta_mensaje_id, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (client_id) DO UPDATE SET resumen = EXCLUDED.resumen, hasta_mensaje_id = EXCLUDED.hasta_mensaje_id, updated_at = NOW()`,
      [client.id, resumen, prev.id]);
    return true;
  } catch (err) {
    console.error(`[Agent] resumen de ${phone || '?'} falló:`, err.code || err.name || 'error');
    return false;
  }
}

module.exports = { maybeSummarize, scrub };
