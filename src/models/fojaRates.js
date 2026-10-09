// Tarifas por foja (cada cara impresa es una foja) y precio de duplicados.
const FOJA_RATES = { carta_simple: 150, carta_motivada: 300, legal_simple: 250, legal_motivada: 350 };

// Duplicado u original extra: 500 si el documento tiene 1–2 fojas, 700 si tiene 3 o más.
function duplicadoPrice(fojas) {
  return Number(fojas) >= 3 ? 700 : 500;
}

// Entero positivo o null (0, negativos, decimales y texto cuentan como no dado).
function validFojas(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

module.exports = { FOJA_RATES, duplicadoPrice, validFojas };
