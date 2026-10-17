// Tarifas por foja (cada cara impresa es una foja) y precio de duplicados.
// modificacion: el cliente trae el modelo y solo se cambian datos.
const FOJA_RATES = { carta_simple: 150, carta_motivada: 300, legal_simple: 250, legal_motivada: 350, modificacion: 150 };
// Modificación de 3 fojas o más (todas modificadas): rango de MODIFICACION_PISO a la tarifa por foja; lo confirma el digitador.
const MODIFICACION_PISO = 100;
const MODIFICACION_FOJAS_RANGO = 3;

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

module.exports = { FOJA_RATES, MODIFICACION_PISO, MODIFICACION_FOJAS_RANGO, duplicadoPrice, validFojas };
