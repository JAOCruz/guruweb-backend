const pool = require('../../db/pool');
const { fold } = require('../text');
const { calculatePrice } = require('../../models/servicePricing');

const SELECT = `SELECT s.*, c.name AS categoria FROM service_catalog s
  LEFT JOIN service_categories c ON c.id = s.category_id`;

function score(service, consulta, words) {
  const name = fold(service.name);
  const aliases = (service.alias || []).map(fold);
  let n = 0;
  if (consulta && aliases.includes(consulta)) n += 10;
  for (const w of words) {
    if (name.includes(w) || aliases.some((a) => a.includes(w))) n += 1;
  }
  return n;
}

async function buscar_servicio(args = {}, ctx) {
  const consulta = fold(args.consulta);
  const words = consulta.split(' ').filter((w) => w.length >= 3);
  if (!consulta) return { resultados: [] };
  const { rows } = await pool.query(`${SELECT} WHERE s.active = true`);
  const resultados = rows
    .map((s) => ({ s, p: score(s, consulta, words) }))
    .filter((x) => x.p > 0)
    .sort((a, b) => b.p - a.p)
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
