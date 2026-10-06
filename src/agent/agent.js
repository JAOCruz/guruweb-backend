// Ciclo del agente: arma el contexto, llama al modelo con las herramientas, las ejecuta (máximo 6 por turno),
// reintenta una vez, maneja cuota y traspaso, serializa los turnos por teléfono y pasa la respuesta por el
// filtro de precios. Nunca devuelve un error técnico al cliente.
// Los registros (console) solo llevan teléfono, nombres de herramientas, conteos, tiempos y códigos de error.
const pool = require('../db/pool');
const Client = require('../models/Client');
const { getProvider, withTimeout } = require('./provider');
const { TOOLS, runTool } = require('./tools');
const { buildContext } = require('./context');
const { maybeSummarize } = require('./memory');
const { getBusinessInfo } = require('./businessInfo');
const { fold } = require('./text');
const { priceGuard } = require('./priceGuard');

// Mismo valor que src/conversation/router.js; se repite aquí para no cargar el motor viejo en el agente.
const AI_DEFERRED = '<<AI_DEFERRED>>';
const MAX_TOOLS = 6;
const TIMEOUT_MS = 25000;
const DELIVER_TIMEOUT_MS = 20000; // tope para deliver dentro del candado: si el envío se cuelga, la cola del teléfono sigue
const REPEAT_LIMIT = 3;
const CURRENT_TURN_MS = 2 * 60 * 1000; // un inbound guardado hace menos de esto es el lote actual (como en memory.js)
// Solo si no se pudo leer el de business_info (mismo texto que la migración).
const FALLBACK_WAIT = 'Un miembro de nuestro equipo se comunicará con usted a la brevedad. ⏰ Horario de atención: Lunes a Viernes, ' +
  "9:00 a 18:00 hrs. Si su asunto es urgente fuera de horario, por favor indíquelo escribiendo 'urgente'.";

const ALLOWED_WINDOW_HOURS = 24;   // resultados de herramientas de este teléfono que siguen valiendo como "dichos"
const MAX_TOTALS_FOR_SUMS = 30;
const WRITE_TOOLS = new Set(['crear_solicitud', 'preparar_cotizacion']); // si corrieron, un reintento diferido podría duplicar

const queues = new Map(); // phone → Promise del último ciclo (turno + entrega), en serie por teléfono

let botUserIdCache = null;
async function getBotUserId() {
  if (botUserIdCache == null) {
    const { rows } = await pool.query(`SELECT id FROM users WHERE username = 'bot'`);
    botUserIdCache = rows[0]?.id ?? null;
  }
  return botUserIdCache;
}
function _resetBotUserCache() { botUserIdCache = null; }

// ---------- montos permitidos ----------

const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isObj = (v) => v && typeof v === 'object';

// Junta en `set` todos los montos que devolvió una herramienta: total, precio, rango.min/max, desglose.* y
// cantidad × precio. El desglose de un resultado por confirmar (total nulo) no cuenta: ese monto no se dice.
// Cada `total` también va a `totals` (para permitir sumas de 2 o 3 totales).
function collectAmounts(value, set, totals = [], depth = 0) {
  if (!isObj(value) || depth > 8) return set;
  if (Array.isArray(value)) { for (const v of value) collectAmounts(v, set, totals, depth + 1); return set; }
  for (const [k, v] of Object.entries(value)) {
    if ((k === 'total' || k === 'precio') && positive(v)) { set.add(v); if (k === 'total') totals.push(v); }
    else if (k === 'rango' && isObj(v)) { if (positive(v.min)) set.add(v.min); if (positive(v.max)) set.add(v.max); }
    else if (k === 'desglose' && isObj(v)) {
      if (value.por_confirmar !== true && value.total !== null) for (const d of Object.values(v)) if (positive(d)) set.add(d);
    } else if (isObj(v)) collectAmounts(v, set, totals, depth + 1);
  }
  const unit = positive(value.precio) ? value.precio : positive(value.total) ? value.total : null;
  if (unit !== null && positive(value.cantidad)) set.add(unit * value.cantidad);
  return set;
}

// El valor del bien que el modelo pasó a calcular_precio / preparar_cotizacion (lo dio el cliente y la
// herramienta lo usó): el modelo puede repetirlo con "RD$". Solo de llamadas que salieron bien.
function collectArgAmounts(name, args, set) {
  if (!isObj(args)) return set;
  const add = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0) set.add(n); };
  if (name === 'calcular_precio') add(args.valor_del_bien);
  if (name === 'preparar_cotizacion' && Array.isArray(args.partidas)) for (const p of args.partidas) if (isObj(p)) add(p.valor_del_bien);
  return set;
}

// Sumas de 2 o 3 totales (los últimos MAX_TOTALS_FOR_SUMS): "RD$950 + RD$700 = RD$1,650".
function addSums(set, totals) {
  const t = totals.slice(-MAX_TOTALS_FOR_SUMS);
  for (let i = 0; i < t.length; i++) {
    for (let j = i + 1; j < t.length; j++) {
      set.add(t[i] + t[j]);
      for (let k = j + 1; k < t.length; k++) set.add(t[i] + t[j] + t[k]);
    }
  }
  return set;
}

// Lo que las herramientas de este teléfono devolvieron en las últimas 24 h ya se le dijo (o se pudo decir)
// al cliente: esos montos siguen permitidos. Solo llamadas ok; los montos del cliente nunca entran.
async function seedAllowed(phone, now, set, totals) {
  const { rows } = await pool.query(
    `SELECT herramienta, args, resultado FROM bot_tool_log
     WHERE phone = $1 AND ok = true AND created_at > $2::timestamptz - make_interval(hours => $3)
     ORDER BY id DESC LIMIT 200`, [phone, now.toISOString(), ALLOWED_WINDOW_HOURS]);
  for (const r of rows.reverse()) {
    collectAmounts(r.resultado, set, totals);
    collectArgAmounts(r.herramienta, r.args, set);
  }
}

// ---------- texto del turno e historial ----------

// Texto del cliente más cada medio con su etiqueta. La transcripción de una nota de voz ya viene dentro del
// texto cuando el handler la agregó; en ese caso no se repite.
function turnText(text, media) {
  const parts = [];
  const base = String(text || '').trim();
  if (base) parts.push(base);
  for (const m of media || []) {
    if (!m) continue;
    if (m.transcription) {
      if (!fold(base).includes(fold(m.transcription))) parts.push(`[Nota de voz, id ${m.id}]: ${String(m.transcription).trim()}`);
    } else {
      parts.push(`[Foto/Documento enviado, id ${m.id}]: ${m.analysis ? String(m.analysis).trim() : '(sin análisis; use leer_documento)'}`);
    }
  }
  return parts.join('\n');
}

// Etiquetas que el handler agrega al contenido guardado de un mensaje con medios.
const MEDIA_TAGS = /\[📎[^\]]*\]|\[📷[^\]]*\]:?|\[🎤[^\]]*\]:?/g;

// El handler guarda el lote entrante antes de llamar a respond, así que los últimos mensajes `user` del
// historial pueden ser este mismo lote. Un mensaje final del cliente se considera parte del lote cuando
// cada línea útil (sin etiquetas de medios) está contenida en el texto del turno; se descarta para no
// mandarlo dos veces. Lo que no coincide se conserva (quedará unido al turno nuevo por `normalize`).
function dropCurrentBatch(messages, current, hasMedia) {
  const cur = fold(current);
  const out = messages.slice();
  while (out.length && out[out.length - 1].role === 'user') {
    const lines = String(out[out.length - 1].text).replace(MEDIA_TAGS, '').split('\n').map(fold).filter(Boolean);
    const partOfBatch = lines.length ? lines.every((l) => cur.includes(l)) : hasMedia;
    if (!partOfBatch) break;
    out.pop();
  }
  return out;
}

// Sin turnos iniciales del asistente y sin dos turnos seguidos del mismo rol (Claude los rechaza).
function normalize(messages) {
  const out = [];
  for (const m of messages) {
    if (!out.length && m.role !== 'user') continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role && !last.toolCalls && !m.toolCalls) last.text = `${last.text}\n${m.text}`;
    else out.push({ ...m });
  }
  return out;
}

// ---------- repetición ----------

// Los últimos 3 mensajes inbound (incluido este) iguales después de fold → traspaso sin modelo.
// El handler guarda el lote antes de llamar a respond: si el último inbound guardado es este mismo texto y
// es reciente, es el mensaje actual y no se cuenta dos veces.
async function isRepeating(phone, text, now) {
  const current = fold(text);
  // Respuestas cortas ("si", "ok", "2") se repiten con naturalidad: no cuentan.
  if (!current || current.length <= 3 || /^\d+$/.test(current)) return false;
  const { rows } = await pool.query(
    `SELECT content, created_at FROM messages WHERE phone = $1 AND direction = 'inbound' ORDER BY created_at DESC, id DESC LIMIT $2`,
    [phone, REPEAT_LIMIT]);
  const saved = rows.map((r) => fold(r.content));
  const isCurrent = rows.length && saved[0] === current && Math.abs(now.getTime() - new Date(rows[0].created_at).getTime()) < CURRENT_TURN_MS;
  const prev = isCurrent ? saved.slice(1) : saved.slice(0, REPEAT_LIMIT - 1);
  return prev.length === REPEAT_LIMIT - 1 && prev.every((t) => t === current);
}

// ---------- traspaso ----------

async function handoff(ctx, motivo) {
  try {
    const r = await runTool('pasar_a_humano', { motivo }, ctx);
    if (r && r.mensaje) return r.mensaje;
  } catch (err) {
    console.error(`[Agent] ${ctx.phone} traspaso falló:`, err.code || err.name || 'error');
  }
  try { return (await getBusinessInfo()).mensaje_espera || FALLBACK_WAIT; } catch { return FALLBACK_WAIT; }
}

// ---------- el ciclo ----------

class TooManyTools extends Error { constructor() { super('demasiados pasos'); this.code = 'TOO_MANY_TOOLS'; } }

// Si una falla dejó una llamada del asistente sin todos sus resultados, se quita para retomar limpio.
function trimPartial(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls) continue;
    const results = messages.slice(i + 1).filter((x) => x.role === 'tool').length;
    if (results !== m.toolCalls.length) messages.splice(i);
    break;
  }
  return messages;
}

// Un intento del turno sobre el estado acumulado en `turn` (mensajes, herramientas corridas, traspaso, escrituras).
// Un reintento retoma desde donde iba: no repite herramientas ya corridas. Devuelve el texto final o lanza
// (QUOTA, TIMEOUT, TooManyTools, otro).
async function attempt({ provider, system, ctx, turn, stats }) {
  const messages = trimPartial(turn.messages);
  for (;;) {
    // Copia por llamada: el adaptador (y el proveedor falso en pruebas) recibe lo que vio el modelo en ese momento.
    const out = await withTimeout(provider.chat({ system, messages: messages.slice(), tools: TOOLS, timeoutMs: TIMEOUT_MS }), TIMEOUT_MS);
    stats.calls++;
    const toolCalls = Array.isArray(out?.toolCalls) ? out.toolCalls : [];
    const text = String(out?.text || '').trim();
    if (!toolCalls.length) {
      if (!text && !turn.handoffMessage) { const e = new Error('respuesta vacía'); e.code = 'EMPTY'; throw e; }
      return text;
    }
    messages.push({ role: 'assistant', text, toolCalls });
    for (const tc of toolCalls) {
      if (turn.toolCount >= MAX_TOOLS) throw new TooManyTools();
      turn.toolCount++;
      stats.tools++;
      const result = await runTool(tc.name, tc.args, ctx);
      const ok = isObj(result) && !Object.prototype.hasOwnProperty.call(result, 'error');
      collectAmounts(result, turn.allowed, turn.totals);
      if (ok) collectArgAmounts(tc.name, tc.args, turn.allowed);
      if (ok && WRITE_TOOLS.has(tc.name)) turn.wrote = true;
      if (tc.name === 'pasar_a_humano' && result && result.mensaje) turn.handoffMessage = result.mensaje;
      messages.push({ role: 'tool', toolCallId: tc.id, name: tc.name, result });
    }
  }
}

// Un turno: devuelve { reply, toolLogIds }. reply es '' (nada que mandar), AI_DEFERRED o el texto.
async function respondNow(phone, text, { media = [], provider, now = new Date() } = {}) {
  const t0 = Date.now();
  const stats = { calls: 0, tools: 0 };
  const ctx = { phone, client: null, botUserId: null, now, lastText: String(text || ''), toolLogIds: [] };
  // Estado del turno, fuera del try: si algo falla después de un traspaso, se reutiliza su mensaje.
  const turn = { messages: [], toolCount: 0, allowed: new Set(), totals: [], handoffMessage: null, wrote: false };
  const done = (reply, note) => {
    console.log(`[Agent] ${phone} ${note} calls=${stats.calls} tools=${stats.tools} ${Date.now() - t0}ms`);
    return { reply, toolLogIds: ctx.toolLogIds };
  };
  try {
    provider = provider || getProvider();
    ctx.client = await Client.findByPhone(phone);
    ctx.botUserId = await getBotUserId();
    const current = turnText(text, media);
    if (!current) return done('', 'vacío');
    ctx.lastText = current; // con transcripciones: un "urgente" en nota de voz también cuenta

    if (await isRepeating(phone, text, now)) return done(await handoff(ctx, 'repite el mismo mensaje'), 'repetición');

    // Sin esperar: el resumen de la conversación anterior puede tardar y no cambia este turno.
    maybeSummarize({ phone, client: ctx.client, provider, now }).catch(() => {});

    const { system, messages } = await buildContext({ phone, client: ctx.client, now });
    turn.messages = normalize([...dropCurrentBatch(messages, current, media.length > 0), { role: 'user', text: current }]);
    await seedAllowed(phone, now, turn.allowed, turn.totals);

    let answer = null;
    for (let tries = 0; tries < 2 && answer === null; tries++) {
      try {
        answer = await attempt({ provider, system, ctx, turn, stats });
      } catch (err) {
        if (err.code === 'TOO_MANY_TOOLS') return done(turn.handoffMessage || await handoff(ctx, 'demasiados pasos'), 'demasiados pasos');
        // Si ya se pasó a una persona en este intento, el chat está en manual: se manda el mensaje de espera y no se reintenta.
        if (turn.handoffMessage) return done(turn.handoffMessage, `${err.code || 'error'} tras traspaso`);
        // Sin cuota: se difiere, salvo que ya se haya creado algo (un reintento diferido lo duplicaría): pasa a una persona.
        if (err.code === 'QUOTA' && !turn.wrote) return done(AI_DEFERRED, 'cuota');
        console.error(`[Agent] ${phone} intento ${tries + 1} falló:`, err.code || err.name || 'error');
        if (tries === 1 || err.code === 'QUOTA') return done(await handoff(ctx, 'falla del modelo'), 'falla del modelo');
      }
    }

    const guarded = priceGuard(answer, addSums(new Set(turn.allowed), turn.totals));
    if (guarded.blocked.length) console.warn(`[Agent] ${phone} filtro de precios: ${guarded.blocked.length} monto(s) bloqueado(s)`);
    let reply = guarded.text;
    if (turn.handoffMessage && !fold(reply).includes(fold(turn.handoffMessage))) {
      reply = reply ? `${reply}\n\n${turn.handoffMessage}` : turn.handoffMessage;
    }
    return done(reply, 'ok');
  } catch (err) {
    console.error(`[Agent] ${phone} turno falló:`, err.code || err.name || 'error');
    return done(turn.handoffMessage || await handoff(ctx, 'falla del agente'), 'falla del agente');
  }
}

/**
 * Responde un lote del cliente con el agente.
 * @param {string} phone
 * @param {string} text texto del lote (puede ir vacío si solo hay medios)
 * @param {object} [opts]
 * @param {Array}  [opts.media] medios del lote: { id, media_type, analysis?, transcription? }
 * @param {object} [opts.provider] adaptador del modelo (por defecto getProvider())
 * @param {Date}   [opts.now]
 * @param {(text: string) => Promise<number|null>} [opts.deliver] envía y guarda la respuesta; devuelve el id del
 *   mensaje guardado (o null). Corre dentro del candado del teléfono y las herramientas del turno se ligan a ese id.
 *   Tiene un tope de opts.deliverTimeoutMs (20 s por defecto): pasado ese tiempo el ciclo sigue sin ligar nada.
 * @param {number} [opts.deliverTimeoutMs]
 * @returns {Promise<string>} el texto enviado/por enviar; '' significa "nada que mandar" (lote vacío);
 *   AI_DEFERRED significa "sin cuota, reintente después". deliver no se llama en esos dos casos.
 *
 * Los ciclos de un mismo teléfono (turno + entrega) van en serie: el siguiente arranca cuando el anterior entregó.
 */
function respond(phone, text, opts = {}) {
  const prev = queues.get(phone) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const { reply, toolLogIds } = await respondNow(phone, text, opts);
    if (typeof opts.deliver === 'function' && reply && reply !== AI_DEFERRED) {
      try {
        const messageId = await withTimeout(Promise.resolve(opts.deliver(reply)), opts.deliverTimeoutMs || DELIVER_TIMEOUT_MS);
        await attachToolLogs(messageId, toolLogIds);
      } catch (err) {
        console.error(`[Agent] ${phone} entrega falló:`, err.code || err.name || 'error');
      }
    }
    return reply;
  });
  queues.set(phone, run);
  return run.finally(() => { if (queues.get(phone) === run) queues.delete(phone); });
}

// Liga las herramientas de un turno (ids de bot_tool_log) al mensaje del bot ya guardado. Devuelve cuántas ligó.
async function attachToolLogs(messageId, ids) {
  if (!messageId || !Array.isArray(ids) || !ids.length) return 0;
  const { rowCount } = await pool.query('UPDATE bot_tool_log SET message_id = $1 WHERE id = ANY($2)', [messageId, ids]);
  return rowCount;
}

module.exports = {
  respond, attachToolLogs, AI_DEFERRED, collectAmounts, collectArgAmounts, addSums, priceGuard,
  turnText, normalize, dropCurrentBatch, _resetBotUserCache,
};
