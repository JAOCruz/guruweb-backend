const pool = require('../../db/pool');
const Invoice = require('../../models/Invoice');
const { calculatePrice } = require('../../models/servicePricing');
const { activeAdminIds, notifyUsers } = require('./notify');
const { ensureClient } = require('./client');

// partidas: [{ servicio_id, cantidad?, valor_del_bien?, con_notarizacion? }]
// El bot nunca manda precios: todo se recalcula con el catálogo.
async function preparar_cotizacion(args, ctx) {
  const partidas = args && args.partidas;
  if (!Array.isArray(partidas) || !partidas.length) return { error: 'partidas requeridas' };
  const client = await ensureClient(ctx);
  if (!client?.id) return { error: 'cliente no encontrado' };

  const items = [];
  const sinPrecio = [];
  const faltaValor = []; // partidas por tramos sin valor_del_bien
  for (const p of partidas) {
    const id = Number(p && p.servicio_id);
    const { rows } = Number.isInteger(id)
      ? await pool.query('SELECT * FROM service_catalog WHERE id = $1 AND active = true', [id])
      : { rows: [] };
    const s = rows[0];
    if (!s) { sinPrecio.push(String(p && p.servicio_id)); continue; }
    const cantidad = Math.max(1, Math.floor(Number(p.cantidad) || 1));
    const opts = {
      assetValue: p.valor_del_bien == null ? null : Number(p.valor_del_bien),
      includeNotarization: p.con_notarizacion !== false,
    };
    const unit = calculatePrice(s, { ...opts, quantity: 1 });
    if (unit.falta === 'valor_del_bien') { faltaValor.push(s.name); continue; }
    if (unit.total === null || unit.total <= 0) { sinPrecio.push(s.name); continue; }
    let desc = s.name;
    if (unit.tramo) desc += ` (tramo ${unit.tramo})`;
    else if (opts.assetValue) desc += ` (valor ${opts.assetValue})`;
    items.push({ desc, cantidad, precio: unit.total });
  }
  if (sinPrecio.length || faltaValor.length) {
    const out = { error: sinPrecio.length ? 'hay partidas sin precio confirmado' : 'falta el valor del bien' };
    if (sinPrecio.length) out.sin_precio = sinPrecio;
    if (faltaValor.length) out.falta_valor = faltaValor;
    return out;
  }

  const subtotal = items.reduce((a, i) => a + i.cantidad * i.precio, 0);
  const { generateDocNumber } = require('../../documents/generateInvoice'); // perezoso: arrastra puppeteer/storage
  const inv = await Invoice.create({
    docNumber: generateDocNumber('COT'), type: 'COTIZACIÓN', clientId: client.id,
    clientName: client.name || ctx.phone, clientPhone: ctx.phone, items,
    subtotal, itbis: 0, total: subtotal, createdBy: ctx.botUserId, source: 'bot',
  });
  const pending = await Invoice.requestApproval(inv.id);

  await notifyUsers(await activeAdminIds(), {
    type: 'invoice', title: 'Cotización por aprobar (bot de WhatsApp)',
    message: `${inv.doc_number} — ${client.name || ctx.phone}: RD$${subtotal}`,
    link: '/cotizaciones', metadata: { invoice_id: inv.id, doc_number: inv.doc_number },
  });
  // invoice_id: para que preparar_documento ligue el documento a esta cotización
  return { cotizacion: inv.doc_number, invoice_id: inv.id, total: subtotal, estado: (pending || inv).status };
}

module.exports = { preparar_cotizacion };
