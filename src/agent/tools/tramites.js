const pool = require('../../db/pool');
const { fold } = require('../text');
const { calculatePrice } = require('../../models/servicePricing');

async function ver_tramite(args = {}, ctx) {
  const q = fold(args.nombre);
  const { rows } = await pool.query('SELECT * FROM tramites WHERE activo = true ORDER BY nombre');
  const t = rows.find((r) => fold(r.nombre) === q || (r.alias || []).some((a) => fold(a) === q))
    || (q.length >= 3 ? rows.find((r) => fold(r.nombre).includes(q) || (r.alias || []).some((a) => fold(a).includes(q))) : null);
  if (!t) return { error: 'trámite no encontrado', disponibles: rows.map((r) => r.nombre) };

  const faltan = [];
  let total = 0;
  const pasos = [];
  for (const p of t.pasos || []) {
    let precio = null;
    let dependeDelValor = false;
    if (p.servicio) {
      const r = await pool.query('SELECT * FROM service_catalog WHERE name = $1 AND active = true LIMIT 1', [p.servicio]);
      if (r.rows.length) {
        // Sin valor del bien un paso por tramos no tiene precio: queda en faltan_precios.
        const calc = calculatePrice(r.rows[0]);
        precio = calc.total;
        dependeDelValor = calc.dependeDelValor;
      }
      if (precio === null) faltan.push(p.servicio);
      else total += precio;
    }
    pasos.push({ orden: p.orden, descripcion: p.descripcion, servicio: p.servicio || null, precio, depende_del_valor: dependeDelValor, preguntas: p.preguntas || [] });
  }
  return {
    nombre: t.nombre,
    pasos,
    preguntas_obligatorias: t.preguntas_obligatorias || [],
    reglas: t.reglas || null,
    total: faltan.length ? null : total,
    faltan_precios: faltan,
  };
}

module.exports = { ver_tramite };
