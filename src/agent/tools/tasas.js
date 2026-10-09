// estimar_tasa: busca en la web (proveedor activo) el monto oficial aproximado de una tasa y lo guarda 30 días.
// Nunca lanza: cualquier fallo devuelve por_confirmar. El monto nunca se suma a una cotización.
const pool = require('../../db/pool');
const { fold } = require('../text');
const { getProvider } = require('../provider');

const CACHE_DIAS = 30;
const SEARCH_TIMEOUT_MS = 15000;

const hoy = () => new Date().toISOString().slice(0, 10);
// Ninguna tasa oficial en RD$ baja de esto; un número menor suele ser un porcentaje (p. ej. el 2% de transferencia).
const MONTO_MINIMO = 50;

// Monto en RD$ desde número o texto: "RD$1,500", "1.500" y "RD$1.500,00" son 1500; "2,250.50" es 2250.5.
function parseMonto(v) {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return NaN;
  let s = v.replace(/[^0-9.,]/g, '');
  if (!s) return NaN;
  const punto = s.lastIndexOf('.');
  const coma = s.lastIndexOf(',');
  if (punto !== -1 && coma !== -1) {
    // El separador que va último es el decimal; el otro es de miles.
    s = coma > punto ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (coma !== -1) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (punto !== -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  return Number(s);
}

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
      'Si la tasa es un porcentaje (p. ej. 2% del valor), ponga el porcentaje en "nota" y monto null; nunca ponga un porcentaje en "monto". ' +
      'Responda SOLO con JSON: {"monto": número en RD$ o null si no lo encuentra, "fuente": "url", "nota": "aclaración corta"}.';
    const res = await provider.search({ prompt, timeoutMs: SEARCH_TIMEOUT_MS });
    const data = parseRespuesta(res && res.text);
    const monto = parseMonto(data ? data.monto : null);
    if (!Number.isFinite(monto) || monto < MONTO_MINIMO) return porConfirmar;

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
