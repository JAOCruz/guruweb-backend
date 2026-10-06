const pool = require('../../db/pool');
const legalProfile = require('../../documentos/legalProfile');
const Client = require('../../models/Client');

// Inyectable para pruebas; por defecto se carga el análisis real de forma perezosa.
let analyzer = null;
function _setAnalyzer(fn) { analyzer = fn; }

const looksLikePhone = (n) => !n || /^[\d\s+()-]+$/.test(String(n).trim());

// El cliente del chat; si todavía no está registrado se crea por teléfono (nombre = el número, hasta que
// lo dé) y queda en ctx.client. Sin asignado: las solicitudes avisan a los admins (asignación: fase 2).
async function ensureClient(ctx) {
  if (ctx.client?.id) return ctx.client;
  const phone = String(ctx.phone || '').trim();
  const digits = phone.replace(/\D/g, '');
  if (!digits) return null;
  let client = await Client.findByPhone(phone);
  if (!client) {
    try {
      client = await Client.create({ name: digits, phone, userId: ctx.botUserId || null, source: 'whatsapp' });
    } catch (err) {
      if (err.code !== '23505') throw err; // otro turno lo creó al mismo tiempo
      client = await Client.findByPhone(phone);
    }
  }
  ctx.client = client;
  return client;
}

async function guardar_datos_cliente(args, ctx) {
  const campos = args && args.campos;
  if (!campos || typeof campos !== 'object' || Array.isArray(campos)) return { error: 'campos inválidos' };
  const clientId = (await ensureClient(ctx))?.id;
  if (!clientId) return { error: 'cliente no encontrado' };

  const current = await legalProfile.get(clientId);
  const byNorm = new Map(Object.entries(current).map(([k, v]) => [legalProfile.norm(k), [k, v]]));
  const data = {};
  const cambios = [];
  const historial = Array.isArray(current.HISTORIAL) ? [...current.HISTORIAL] : [];
  const fecha = (ctx.now ? new Date(ctx.now) : new Date()).toISOString();

  for (const [rawKey, rawVal] of Object.entries(campos)) {
    const clave = legalProfile.norm(rawKey);
    const valor = rawVal == null ? '' : String(rawVal).trim();
    if (!clave || !valor || clave === 'HISTORIAL') continue;
    const prev = byNorm.get(clave);
    const antes = prev ? prev[1] : undefined;
    if (antes === valor) continue;
    if (antes !== undefined && antes !== '') {
      historial.push({ clave, antes, fecha });
    }
    cambios.push({ clave, antes: antes === undefined ? null : antes, ahora: valor });
    data[prev ? prev[0] : clave] = valor;
  }
  if (!cambios.length) return { guardado: [], cambios: [] };
  if (historial.length !== (Array.isArray(current.HISTORIAL) ? current.HISTORIAL.length : 0)) data.HISTORIAL = historial;

  await legalProfile.merge(clientId, data, ctx.botUserId || null);

  const nombre = cambios.find((c) => c.clave === 'NOMBRE');
  if (nombre && looksLikePhone(ctx.client.name)) {
    await Client.update(clientId, { name: nombre.ahora });
    ctx.client.name = nombre.ahora;
  }
  return { guardado: cambios.map((c) => c.clave), cambios };
}

async function leer_documento(args, ctx) {
  const mediaId = args && args.media_id;
  if (mediaId == null || !Number.isInteger(Number(mediaId))) return { error: 'archivo no encontrado' };
  const { rows } = await pool.query('SELECT * FROM client_media WHERE id = $1 AND phone = $2', [Number(mediaId), ctx.phone]);
  const media = rows[0];
  if (!media) return { error: 'archivo no encontrado' };

  if (media.wa_message_id) {
    const m = await pool.query('SELECT content FROM messages WHERE wa_message_id = $1 ORDER BY id LIMIT 1', [media.wa_message_id]);
    const content = m.rows[0]?.content || '';
    const found = content.match(/\[📷 [^\]]*analizad[ao]\]:\s*([\s\S]+)$/);
    if (found && found[1].trim()) return { tipo: media.media_type, datos_extraidos: found[1].trim() };
  }
  const analyze = analyzer || require('../../llm/mediaAnalysis').analyzeDocument;
  let text = null;
  try { text = await analyze(media.file_path, media.mime_type, media.media_type); } catch (err) {
    console.error('[Agent] leer_documento falló:', err.code || err.name || 'error');
  }
  if (!text) return { error: 'no se pudo leer el documento' };
  return { tipo: media.media_type, datos_extraidos: text };
}

module.exports = { guardar_datos_cliente, leer_documento, ensureClient, _setAnalyzer };
