const pool = require('../../db/pool');
const Invoice = require('../../models/Invoice');
const { calculatePrice } = require('../../models/servicePricing');
const { duplicadoPrice, validFojas } = require('../../models/fojaRates');
const { activeAdminIds, assigneeOrAdmins, notifyUsers } = require('./notify');
const { ensureClient } = require('./client');

const NOTA = {
  modificacion: 'Modificación de 3 fojas o más: lo confirma el digitador dentro del rango',
  traduccion: 'Individual o en conjunto (una sola firma): lo confirma el digitador',
  rango: 'Precio dentro del rango: lo confirma el digitador',
  otro: 'Precio por confirmar: lo confirma el digitador',
};
// Por el nombre: la categoría "Redactar y Certificar una Traducción" también guarda las Instancias.
const isTranslation = (s) => /^traducci/i.test(String(s.name || '').trim());

// partidas: [{ servicio_id, cantidad?, valor_del_bien?, con_notarizacion?, fojas?, duplicados? }]
// El bot nunca manda precios: todo se recalcula con el catálogo.
// Una partida sin precio fijo (rango, por confirmar, precio 0, modificación de 3+ fojas) y toda traducción van como
// línea por confirmar: { desc, cantidad, precio: null, por_confirmar: true, rango, precio_sugerido, nota }
// (rango y precio_sugerido por unidad, como precio). El digitador asignado o el admin pone el precio.
async function preparar_cotizacion(args, ctx) {
  const partidas = args && args.partidas;
  if (!Array.isArray(partidas) || !partidas.length) return { error: 'partidas requeridas' };
  const client = await ensureClient(ctx);
  if (!client?.id) return { error: 'cliente no encontrado' };

  const items = [];
  const noExiste = [];
  const faltaValor = []; // partidas por tramos sin valor_del_bien
  for (const p of partidas) {
    const id = Number(p && p.servicio_id);
    const { rows } = Number.isInteger(id)
      ? await pool.query(
        `SELECT s.*, c.name AS categoria FROM service_catalog s LEFT JOIN service_categories c ON c.id = s.category_id
         WHERE s.id = $1 AND s.active = true`, [id])
      : { rows: [] };
    const s = rows[0];
    if (!s) { noExiste.push(String(p && p.servicio_id)); continue; }
    const cantidad = Math.max(1, Math.floor(Number(p.cantidad) || 1));
    const opts = {
      assetValue: p.valor_del_bien == null ? null : Number(p.valor_del_bien),
      includeNotarization: p.con_notarizacion !== false,
    };
    const unit = calculatePrice(s, { ...opts, quantity: 1, fojas: p.fojas }); // los duplicados van en su propia línea
    if (unit.falta === 'valor_del_bien') { faltaValor.push(s.name); continue; }
    let desc = s.name;
    if (unit.tramo) desc += ` (tramo ${unit.tramo})`;
    else if (opts.assetValue) desc += ` (valor ${opts.assetValue})`;
    if (unit.tarifaPorFoja !== null && unit.fojas) desc += ` (${unit.fojas} fojas)`;
    const fixed = unit.total !== null && unit.total > 0 ? unit.total : null;
    if (fixed !== null && !isTranslation(s)) {
      items.push({ desc, cantidad, precio: fixed });
    } else {
      const modif = s.foja_tipo === 'modificacion' && unit.rango;
      const nota = modif ? NOTA.modificacion : isTranslation(s) ? NOTA.traduccion : unit.rango ? NOTA.rango : NOTA.otro;
      // precio_sugerido: el de catálogo, de referencia para el digitador. Al bot solo se le devuelve el de una traducción
      // (un servicio por confirmar tiene un precio que aún no está aprobado y no se le dice al cliente).
      items.push({ desc, cantidad, precio: null, por_confirmar: true, rango: unit.rango || null,
        precio_sugerido: fixed ?? unit.precioSugerido ?? null, nota, ...(isTranslation(s) ? { traduccion: true } : {}) });
    }
    const dup = validFojas(p.duplicados);
    if (dup) items.push({ desc: 'Original adicional o duplicado', cantidad: dup, precio: duplicadoPrice(unit.fojas ?? validFojas(s.fojas) ?? 1) });
  }
  if (noExiste.length || faltaValor.length) {
    const out = { error: noExiste.length ? 'hay partidas sin precio confirmado' : 'falta el valor del bien' };
    if (noExiste.length) out.sin_precio = noExiste;
    if (faltaValor.length) out.falta_valor = faltaValor;
    return out;
  }

  const subtotal = items.reduce((a, i) => a + (i.precio === null ? 0 : i.cantidad * i.precio), 0);
  const pendientes = items.filter((i) => i.por_confirmar);
  const { generateDocNumber } = require('../../documents/generateInvoice'); // perezoso: arrastra puppeteer/storage
  const inv = await Invoice.create({
    docNumber: generateDocNumber('COT'), type: 'COTIZACIÓN', clientId: client.id,
    clientName: client.name || ctx.phone, clientPhone: ctx.phone, items,
    subtotal, itbis: 0, total: subtotal, createdBy: ctx.botUserId, source: 'bot',
  });
  const pending = await Invoice.requestApproval(inv.id);

  const link = `/cotizaciones?invoice=${inv.id}`;
  const metadata = { invoice_id: inv.id, doc_number: inv.doc_number };
  if (pendientes.length) {
    // Los precios los pone el asignado del cliente (o, sin asignado, un admin)
    await notifyUsers((await assigneeOrAdmins(client.assigned_to)).recipients, {
      type: 'invoice', title: '💲 Cotización con precios por confirmar',
      message: `${inv.doc_number} — ${client.name || ctx.phone}: ${pendientes.length} ${pendientes.length === 1 ? 'precio' : 'precios'} por confirmar`,
      link, metadata,
    });
  } else {
    await notifyUsers(await activeAdminIds(), {
      type: 'invoice', title: 'Cotización por aprobar (bot de WhatsApp)',
      message: `${inv.doc_number} — ${client.name || ctx.phone}: RD$${subtotal}`, link, metadata,
    });
  }
  // invoice_id: para que preparar_documento ligue el documento a esta cotización
  const out = { cotizacion: inv.doc_number, invoice_id: inv.id, total: subtotal, estado: (pending || inv).status };
  if (pendientes.length) {
    out.por_confirmar = pendientes.map((i) => ({ desc: i.desc, rango: i.rango, precio_sugerido: i.traduccion ? i.precio_sugerido : null }));
  }
  return out;
}

module.exports = { preparar_cotizacion };
