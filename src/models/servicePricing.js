// Cálculo de precio compartido (ruta /calculate y herramientas del agente).
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function calculatePrice(service, { assetValue = null, quantity = 1, includeNotarization = true } = {}) {
  const qty = Number(quantity) || 1;
  const rango = service.precio_rango || null;
  const dig = num(service.digitacion_price);
  const notBase = num(service.notarizacion_price);
  const digitacion = (dig || 0) * qty;
  let notarizacion = 0;
  let tramo = null;
  let tierPorConfirmar = false;
  let hasPrice = dig !== null;

  if (includeNotarization && notBase) {
    hasPrice = true;
    const tiers = service.price_tiers || [];
    let matched = null;
    if (tiers.length > 0 && assetValue) {
      const val = Number(assetValue) || 0;
      matched = tiers.find((t) =>
        t.min !== undefined && val >= t.min &&
        (t.max === null || t.max === undefined || val <= t.max)) || null;
    }
    if (matched) {
      notarizacion = Number(matched.price) * qty;
      tramo = `${matched.min}-${matched.max === null || matched.max === undefined ? '' : matched.max}`;
      tierPorConfirmar = matched.por_confirmar === true;
    }
    if (notarizacion === 0) notarizacion = notBase * qty;
  }

  const porConfirmar = service.por_confirmar === true || tierPorConfirmar;
  const total = porConfirmar || !hasPrice ? null : digitacion + notarizacion;
  return { total, breakdown: { digitacion, notarizacion }, porConfirmar, rango, tramo };
}

module.exports = { calculatePrice };
