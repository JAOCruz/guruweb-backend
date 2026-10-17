// Cálculo de precio compartido (ruta /calculate y herramientas del agente).
const { FOJA_RATES, MODIFICACION_PISO, MODIFICACION_FOJAS_RANGO, duplicadoPrice, validFojas } = require('./fojaRates');

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Devuelve { total, breakdown, porConfirmar, rango, tramo, falta, dependeDelValor, fojas, tarifaPorFoja, fojasEstimadas, precioSugerido }.
// - Con precio_rango y sin digitacion_price, foja_tipo se ignora (total null, se da el rango).
// - Con service.foja_tipo (carta_simple|carta_motivada|legal_simple|legal_motivada) la digitación es
//   tarifa × fojas × cantidad e ignora digitacion_price. Fojas: la pasada (válida) > service.fojas > 1;
//   fojasEstimadas es true si no se pasaron fojas.
// - duplicados (copias u originales extra) suma duplicadoPrice(fojas del documento) × duplicados
//   (500 si 1–2 fojas, 700 si 3+) y aparece en breakdown.duplicados solo si es > 0. No se multiplica por cantidad.
// - Con tramos (price_tiers) y notarización incluida, la notarización sale del tramo del valor del bien,
//   aunque el servicio no tenga notarizacion_price base (p. ej. "Contrato de Venta Bienes").
// - Con tramos y sin valor del bien: total null y falta = 'valor_del_bien' (hay que preguntarlo).
// - Con tramos y un valor que no cae en ninguno (hueco): total null y porConfirmar.
// - foja_tipo 'modificacion' con 3 fojas o más: total null, porConfirmar y rango de MODIFICACION_PISO a la tarifa
//   (× fojas × cantidad, más la notarización si aplica). Con menos fojas, tarifa × fojas × cantidad.
// - precioSugerido: si solo service.por_confirmar deja el total en null, el total que tendría sin esa marca.
function calculatePrice(service, opts = {}) {
  const r = evaluate(service, opts);
  let precioSugerido = null;
  if (service.por_confirmar === true) {
    const sin = evaluate({ ...service, por_confirmar: false }, opts);
    if (sin.total !== null && sin.total > 0) precioSugerido = sin.total;
  }
  return { ...r, precioSugerido };
}

function evaluate(service, { assetValue = null, quantity = 1, includeNotarization = true, fojas = null, duplicados = 0 } = {}) {
  const qty = Number(quantity) || 1;
  const rango = service.precio_rango || null;
  const dig = num(service.digitacion_price);
  const notBase = num(service.notarizacion_price);
  const tiers = Array.isArray(service.price_tiers) ? service.price_tiers : [];
  // Un servicio por rango sin digitación (p. ej. Antiplagio) no va por foja aunque tenga foja_tipo.
  const soloRango = rango !== null && dig === null;
  const rate = soloRango ? null : FOJA_RATES[service.foja_tipo] ?? null;
  const fojasDadas = validFojas(fojas);
  const nFojas = fojasDadas ?? validFojas(service.fojas) ?? 1;
  const nDup = validFojas(duplicados) ?? 0;
  const digitacion = rate !== null ? rate * nFojas * qty : (dig || 0) * qty;
  let notarizacion = 0;
  let tramo = null;
  let tierPorConfirmar = false;
  let falta = null;
  let hasPrice = rate !== null || dig !== null;

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

  const modifRango = service.foja_tipo === 'modificacion' && rate !== null && nFojas >= MODIFICACION_FOJAS_RANGO;
  const porConfirmar = service.por_confirmar === true || tierPorConfirmar || modifRango;
  const duplicadosTotal = nDup > 0 ? duplicadoPrice(nFojas) * nDup : 0;
  const total = porConfirmar || !hasPrice || falta ? null : digitacion + notarizacion + duplicadosTotal;
  const breakdown = { digitacion, notarizacion };
  if (nDup > 0) breakdown.duplicados = duplicadosTotal;
  const rangoFinal = modifRango
    ? { min: MODIFICACION_PISO * nFojas * qty + notarizacion, max: rate * nFojas * qty + notarizacion }
    : rango;
  return {
    total, breakdown, porConfirmar, rango: rangoFinal, tramo, falta, dependeDelValor: tiers.length > 0,
    fojas: rate !== null || fojasDadas !== null ? nFojas : null,
    tarifaPorFoja: rate, fojasEstimadas: rate !== null && fojasDadas === null,
  };
}

module.exports = { calculatePrice };
