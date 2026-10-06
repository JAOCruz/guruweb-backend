const pool = require('../../db/pool');
const { fold } = require('../text');
const { calculatePrice } = require('../../models/servicePricing');

const SELECT = `SELECT s.*, c.name AS categoria FROM service_catalog s
  LEFT JOIN service_categories c ON c.id = s.category_id`;

const STOPWORDS = new Set(('de del la las el los un una unos por con para que quiero necesito hacer mi me ' +
  'cuanto cuesta precio sale es y o a en').split(' '));

const tokens = (s) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);
// Variantes para un plural burdo: t, t sin "s", t sin "es".
function variants(t) {
  const v = [t];
  if (t.length > 3 && t.endsWith('s')) v.push(t.slice(0, -1));
  if (t.length > 4 && t.endsWith('es')) v.push(t.slice(0, -2));
  return v;
}
const forms = (list) => {
  const set = new Set();
  for (const t of list) for (const x of variants(t)) set.add(x);
  return set;
};
const hits = (qVariants, docForms) => qVariants.some((x) => docForms.has(x));

function rank(rows, consulta, qTokens) {
  const docs = rows.map((s) => {
    const nameForms = forms(tokens(s.name));
    const aliasList = (s.alias || []).map(fold);
    const aliasForms = forms(aliasList.flatMap(tokens));
    return { s, nameForms, aliasForms, aliasList };
  });
  const N = docs.length;
  const scored = docs.map((d) => {
    let points = d.aliasList.includes(consulta) ? 10 : 0;
    let nameHits = 0;
    for (const q of qTokens) {
      const qv = variants(q);
      const df = docs.filter((o) => hits(qv, o.nameForms) || hits(qv, o.aliasForms)).length;
      if (!df) continue;
      const idf = Math.log(1 + N / df);
      if (hits(qv, d.nameForms)) { points += 3 * idf; nameHits += 1; }
      else if (hits(qv, d.aliasForms)) points += 1.5 * idf;
    }
    return { s: d.s, points, nameHits };
  });
  return scored.filter((x) => x.points > 0)
    .sort((a, b) => b.points - a.points || b.nameHits - a.nameHits || a.s.id - b.s.id);
}

async function buscar_servicio(args = {}, ctx) {
  const consulta = fold(args.consulta);
  const qTokens = tokens(consulta).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  if (!qTokens.length) return { resultados: [] };
  const { rows } = await pool.query(`${SELECT} WHERE s.active = true ORDER BY s.id`);
  const resultados = rank(rows, consulta, qTokens)
    .slice(0, 5)
    .map(({ s }) => {
      const price = calculatePrice(s);
      return {
        id: s.id,
        nombre: s.name,
        categoria: s.categoria || null,
        precio: price.total,
        rango: price.rango,
        por_confirmar: price.porConfirmar,
        incluye: s.incluye || null,
        reglas: s.reglas || null,
        requisitos: s.requisitos || null,
        notarizacion: s.notarizacion || null,
        tiempo_entrega: s.tiempo_entrega || null,
        unidad: s.unit_type || null,
      };
    });
  return { resultados };
}

async function calcular_precio(args = {}, ctx) {
  const id = Number(args.servicio_id);
  if (!Number.isInteger(id)) return { error: 'servicio no encontrado' };
  const { rows } = await pool.query(`${SELECT} WHERE s.id = $1 AND s.active = true`, [id]);
  if (!rows.length) return { error: 'servicio no encontrado' };
  const s = rows[0];
  const p = calculatePrice(s, {
    assetValue: args.valor_del_bien ?? null,
    quantity: args.cantidad ?? 1,
    includeNotarization: args.con_notarizacion !== false,
  });
  return { servicio: s.name, total: p.total, desglose: p.breakdown, por_confirmar: p.porConfirmar, rango: p.rango, tramo: p.tramo };
}

module.exports = { buscar_servicio, calcular_precio };
