// estimar_tasa: busca en la web (proveedor activo) el monto oficial aproximado de una tasa y lo guarda 30 días.
// Nunca lanza: cualquier fallo devuelve por_confirmar. El monto nunca se suma a una cotización.
const pool = require('../../db/pool');
const { fold } = require('../text');
const { getProvider } = require('../provider');

const CACHE_DIAS = 30;
const SEARCH_TIMEOUT_MS = 15000;

const hoy = () => new Date().toISOString().slice(0, 10);

// Primer objeto JSON con clave "monto": prueba cada '{' contra cada '}' posterior (tolera prosa con llaves y '}' dentro de textos).
function parseRespuesta(text) {
  const s = String(text || '');
  for (let i = s.indexOf('{'); i !== -1; i = s.indexOf('{', i + 1)) {
    for (let j = s.indexOf('}', i); j !== -1; j = s.indexOf('}', j + 1)) {
      try {
        const o = JSON.parse(s.slice(i, j + 1));
        if (o && typeof o === 'object' && !Array.isArray(o) && 'monto' in o) return o;
      } catch { /* sigue probando */ }
    }
  }
  return null;
}

async function estimar_tasa(args, ctx = {}) {
  const concepto = String((args && args.concepto) || '').trim();
  const porConfirmar = { concepto, monto_aproximado: null, por_confirmar: true };
  try {
    const key = fold(concepto).trim();
    if (!key) return porConfirmar;

    const { rows } = await pool.query(
      `SELECT monto, fuente, created_at FROM tasas_cache
        WHERE concepto_key = $1 AND created_at > NOW() - ($2 || ' days')::interval`, [key, String(CACHE_DIAS)]);
    if (rows[0] && Number(rows[0].monto) > 0) {
      return { concepto, monto_aproximado: Number(rows[0].monto), fuente: rows[0].fuente || null,
        fecha: new Date(rows[0].created_at).toISOString().slice(0, 10), aproximado: true };
    }

    const provider = ctx.provider || getProvider();
    if (!provider || typeof provider.search !== 'function') return porConfirmar;

    const prompt = `Busque en la web el monto oficial vigente en República Dominicana de: "${concepto}". ` +
      'Use fuentes oficiales (DGII, INTRANT, Procuraduría, ayuntamientos, Banreservas). ' +
      'Responda SOLO con JSON: {"monto": número en RD$ o null si no lo encuentra, "fuente": "url", "nota": "aclaración corta"}.';
    const res = await provider.search({ prompt, timeoutMs: SEARCH_TIMEOUT_MS });
    const data = parseRespuesta(res && res.text);
    const bruto = data ? data.monto : null;
    const monto = typeof bruto === 'string' ? Number(bruto.replace(/[^0-9.]/g, '')) : Number(bruto);
    if (!Number.isFinite(monto) || monto <= 0) return porConfirmar;

    const fuente = (typeof data.fuente === 'string' && data.fuente.trim()) || (res.sources && res.sources[0]) || null;
    const nota = typeof data.nota === 'string' ? data.nota : null;
    await pool.query(
      `INSERT INTO tasas_cache (concepto_key, concepto, monto, fuente, nota, created_at) VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (concepto_key) DO UPDATE SET concepto = EXCLUDED.concepto, monto = EXCLUDED.monto,
         fuente = EXCLUDED.fuente, nota = EXCLUDED.nota, created_at = NOW()`,
      [key, concepto, monto, fuente, nota]);
    return { concepto, monto_aproximado: monto, fuente, fecha: hoy(), aproximado: true };
  } catch (err) {
    console.error('[Agent] estimar_tasa falló:', err.code || err.name || 'error');
    return porConfirmar;
  }
}

module.exports = { estimar_tasa };
