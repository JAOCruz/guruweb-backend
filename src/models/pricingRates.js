// Tarifas que el admin cambia desde el dashboard (Catálogo de Precios › Tarifas), guardadas en pricing_rates:
//   foja:       tarifa por foja de cada tipo (carta/legal, simple/motivada, modificación).
//   traduccion: tipos de traducción con precio por página que baja por tramos de páginas
//               (el tramo se elige por el total de páginas; total = precio del tramo × páginas).
// refreshRates() (caché de 30 s) actualiza FOJA_RATES en su lugar, así calculatePrice sigue siendo síncrono.
// Sin la tabla (migración sin correr) se usan las tarifas de siempre.
const pool = require('../db/pool');
const { FOJA_RATES } = require('./fojaRates');

const DEFAULTS = Object.freeze({
  foja: { carta_simple: 150, carta_motivada: 300, legal_simple: 250, legal_motivada: 350, modificacion: 150 },
  traduccion: {
    tipos: [
      { key: 'carta_sencillo', label: 'Carta sencillo', tramos: [{ desde: 1, precio: 700 }, { desde: 3, precio: 600 }, { desde: 10, precio: 500 }] },
      { key: 'carta_denso', label: 'Carta extensivo o denso', tramos: [{ desde: 1, precio: 1000 }, { desde: 3, precio: 800 }, { desde: 10, precio: 700 }] },
      { key: 'legal_denso', label: 'Legal extensivo o denso', tramos: [{ desde: 1, precio: 1000 }, { desde: 3, precio: 800 }, { desde: 10, precio: 700 }] },
    ],
  },
});
const FOJA_KEYS = Object.keys(DEFAULTS.foja);
const TTL_MS = 30_000;

const clone = (v) => JSON.parse(JSON.stringify(v));
let current = clone(DEFAULTS);
let loadedAt = 0;

function apply(r) {
  current = r;
  Object.assign(FOJA_RATES, r.foja);
  loadedAt = Date.now();
  return current;
}

// null when the table can't be read for a reason other than not existing (then the rates in memory stay)
async function load() {
  const r = clone(DEFAULTS);
  try {
    const { rows } = await pool.query('SELECT key, value FROM pricing_rates');
    for (const row of rows) {
      if (row.key === 'foja' && row.value && typeof row.value === 'object') r.foja = { ...r.foja, ...row.value };
      if (row.key === 'traduccion' && Array.isArray(row.value?.tipos)) r.traduccion = row.value;
    }
  } catch (err) {
    if (err.code === '42P01') return r; // migración sin correr: las de siempre
    console.error('[Tarifas] no se pudieron leer:', err.code || err.message);
    return null;
  }
  return r;
}

let version = 0; // sube con cada guardado: una lectura que empezó antes no pisa lo guardado
async function refreshRates() {
  if (Date.now() - loadedAt < TTL_MS) return current;
  const v = version;
  const r = await load();
  if (v !== version) return current;
  if (!r) { loadedAt = Date.now() - TTL_MS + 5000; return current; } // error: se queda lo que hay y reintenta en 5 s
  return apply(r);
}

async function getRates({ fresh = false } = {}) {
  if (fresh) loadedAt = 0;
  return clone(await refreshRates());
}

// Precio de una traducción del tipo `tipo` con `paginas` páginas (con las tarifas cargadas).
// volumen: páginas de traducción de todo el pedido (la rebaja es por factura, no por documento; Leandro, 2026-11-27).
// El tramo sale del mayor entre las páginas del documento y el volumen; el total, de las páginas del documento.
function traduccionPrecio(tipo, paginas, volumen = null) {
  const t = current.traduccion.tipos.find((x) => x.key === tipo);
  if (!t || !t.tramos.length) return null;
  const n = Math.max(1, Math.floor(Number(paginas) || 1));
  const v = Math.max(n, Math.floor(Number(volumen) || 0));
  const tramos = [...t.tramos].sort((a, b) => a.desde - b.desde);
  let tramo = tramos[0];
  for (const x of tramos) if (v >= x.desde) tramo = x;
  const idx = tramos.indexOf(tramo);
  const hasta = tramos[idx + 1] ? tramos[idx + 1].desde - 1 : null;
  return { porPagina: tramo.precio, total: tramo.precio * n, paginas: n, tramo: { desde: tramo.desde, hasta }, label: t.label };
}

const isPrice = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1_000_000;
const isPage = (v) => Number.isInteger(v) && v >= 1 && v <= 10_000;

// Devuelve un mensaje en español o null.
function validateRates(body) {
  if (!body || typeof body !== 'object') return 'Faltan las tarifas';
  const { foja, traduccion } = body;
  if (!foja || typeof foja !== 'object') return 'Faltan las tarifas por foja';
  for (const k of FOJA_KEYS) if (!isPrice(foja[k])) return `La tarifa por foja «${k}» debe ser un monto mayor que 0`;
  const tipos = traduccion?.tipos;
  if (!Array.isArray(tipos) || !tipos.length) return 'Falta al menos un tipo de traducción';
  const keys = new Set();
  for (const t of tipos) {
    if (!t || typeof t.key !== 'string' || !/^[a-z0-9_]{2,40}$/.test(t.key)) return 'Cada tipo de traducción necesita una clave válida';
    if (keys.has(t.key)) return `El tipo de traducción «${t.key}» está repetido`;
    keys.add(t.key);
    if (typeof t.label !== 'string' || !t.label.trim()) return 'Cada tipo de traducción necesita un nombre';
    if (!Array.isArray(t.tramos) || !t.tramos.length) return `«${t.label}» necesita al menos un tramo`;
    for (let i = 0; i < t.tramos.length; i++) {
      const x = t.tramos[i];
      if (!x || typeof x !== 'object' || !isPage(x.desde) || !isPrice(x.precio)) return `Revise los tramos de «${t.label}»: páginas y precios deben ser mayores que 0`;
      if (i === 0 && x.desde !== 1) return `El primer tramo de «${t.label}» debe empezar en 1 página`;
      if (i > 0 && x.desde <= t.tramos[i - 1].desde) return `Los tramos de «${t.label}» deben ir de menos a más páginas, sin repetirse`;
    }
  }
  return null;
}

const tidy = (body) => ({
  foja: Object.fromEntries(FOJA_KEYS.map((k) => [k, body.foja[k]])),
  traduccion: { tipos: body.traduccion.tipos.map((t) => ({ key: t.key, label: t.label.trim(), tramos: t.tramos.map((x) => ({ desde: x.desde, precio: x.precio })) })) },
});

// Guarda (ya validado) y aplica al momento. Devuelve las tarifas nuevas.
async function saveRates(body, userId) {
  const r = tidy(body);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const key of ['foja', 'traduccion']) {
      await client.query(
        `INSERT INTO pricing_rates (key, value, updated_by, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [key, JSON.stringify(r[key]), userId ?? null]
      );
    }
    // cada tipo tiene su servicio en el catálogo (para que el bot lo encuentre y lo cotice), con su nombre y el precio
    // de 1 página al día; un tipo que se quitó deja su servicio inactivo
    const keys = r.traduccion.tipos.map((t) => t.key);
    await client.query(
      `UPDATE service_catalog SET active = false WHERE traduccion_tipo IS NOT NULL AND NOT (traduccion_tipo = ANY($1::text[]))`, [keys]);
    for (const t of r.traduccion.tipos) {
      const name = `Traducción - ${t.label}`;
      const { rowCount } = await client.query(
        `UPDATE service_catalog SET name = $1, digitacion_price = $2, active = true WHERE traduccion_tipo = $3`,
        [name, t.tramos[0].precio, t.key]);
      if (rowCount) continue;
      await client.query(
        `INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, traduccion_tipo, reglas)
         VALUES ($1, (SELECT id FROM service_categories WHERE name ILIKE '%traducci%' ORDER BY id LIMIT 1), $2, 'por página', true, $3, $4)`,
        [name, t.tramos[0].precio, t.key,
          `${t.label}. Se cobra por página y el precio por página baja con la cantidad de páginas: el total es el precio del tramo por todas las páginas. Pida el documento en foto o PDF. Solo se traduce la versión final y oficial. El digitador confirma el tipo y el precio.`]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  version += 1;
  return clone(apply(r));
}

function _reset() { loadedAt = 0; apply(clone(DEFAULTS)); loadedAt = 0; }

module.exports = { DEFAULTS, refreshRates, getRates, traduccionPrecio, validateRates, saveRates, _reset };
