// Cálculo de precio compartido (ruta /calculate y herramientas del agente).
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Devuelve { total, breakdown, porConfirmar, rango, tramo, falta, dependeDelValor }.
// - Con tramos (price_tiers) y notarización incluida, la notarización sale del tramo del valor del bien,
//   aunque el servicio no tenga notarizacion_price base (p. ej. "Contrato de Venta Bienes").
// - Con tramos y sin valor del bien: total null y falta = 'valor_del_bien' (hay que preguntarlo).
// - Con tramos y un valor que no cae en ninguno (hueco): total null y porConfirmar.
function calculatePrice(service, { assetValue = null, quantity = 1, includeNotarization = true } = {}) {
  const qty = Number(quantity) || 1;
  const rango = service.precio_rango || null;
  const dig = num(service.digitacion_price);
  const notBase = num(service.notarizacion_price);
  const tiers = Array.isArray(service.price_tiers) ? service.price_tiers : [];
  const digitacion = (dig || 0) * qty;
  let notarizacion = 0;
  let tramo = null;
  let tierPorConfirmar = false;
  let falta = null;
  let hasPrice = dig !== null;

  if (includeNotarization && tiers.length > 0) {
    const val = num(assetValue);
    if (val === null || val <= 0) {
      falta = 'valor_del_bien';
    } else {
      const matched = tiers.find((t) =>
        t.min !== undefined && val >= Number(t.min) &&
        (t.max === null || t.max === undefined || val <= Number(t.max))) || null;
      const price = matched ? num(matched.price) : null;
      if (matched && price !== null) {
        hasPrice = true;
        notarizacion = price * qty;
        tramo = `${matched.min}-${matched.max === null || matched.max === undefined ? '' : matched.max}`;
        tierPorConfirmar = matched.por_confirmar === true;
      } else {
        tierPorConfirmar = true; // sin tramo para ese valor: lo confirma una persona
      }
    }
  } else if (includeNotarization && notBase) {
    hasPrice = true;
    notarizacion = notBase * qty;
  }

  const porConfirmar = service.por_confirmar === true || tierPorConfirmar;
  const total = porConfirmar || !hasPrice || falta ? null : digitacion + notarizacion;
  return { total, breakdown: { digitacion, notarizacion }, porConfirmar, rango, tramo, falta, dependeDelValor: tiers.length > 0 };
}

module.exports = { calculatePrice };
