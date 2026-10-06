// Filtro de precios: un monto en la respuesta del modelo solo pasa si salió de una herramienta en este turno.
// Un monto es dinero solo cuando lleva moneda: "RD$ 1,500", "RD$1500", "$1500", "RD $950", "US$100" o "1,500 pesos".
// Cédulas, fechas, horas, teléfonos, porcentajes y cantidades sin moneda no se tocan.
const REPLACEMENT = '(se lo confirmo)';

// Número con miles y decimales: "1,500", "1,500.00", "1.500" (miles con punto), "950.50", "1500".
const NUM = '\\d{1,3}(?:[.,]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?';
// Alt 1: moneda antes ("RD$", "RD $", "US$", "$"), opcionalmente "pesos" después. Alt 2: número seguido de "pesos".
const MONEY = new RegExp(`(?:(?:RD|US)\\s?\\$\\s?|\\$\\s?)(${NUM})(?:\\s?pesos\\b)?(?!\\d)|(?<![\\d.,-])(${NUM})\\s?pesos\\b`, 'gi');

// "1,500" → 1500; "1,500.00" → 1500; "1.500" → 1500; "1.500,50" → 1500.5; "950.50" → 950.5; "12,5" → 12.5.
function parseAmount(s) {
  const t = String(s);
  let plain;
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) plain = t.replace(/,/g, '');
  else if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) plain = t.replace(/\./g, '').replace(',', '.');
  else plain = t.replace(',', '.');
  const n = Number(plain);
  return Number.isFinite(n) ? n : null;
}

// Se comparan en centavos para que RD$1,500 == 1500 == 1500.00.
const cents = (n) => Math.round(Number(n) * 100);

function priceGuard(text, allowed = new Set()) {
  const ok = new Set([...allowed].filter((n) => Number.isFinite(Number(n))).map(cents));
  const blocked = [];
  const out = String(text == null ? '' : text).replace(MONEY, (match, a, b) => {
    const n = parseAmount(a !== undefined ? a : b);
    if (n === null || ok.has(cents(n))) return match;
    blocked.push(n);
    return REPLACEMENT;
  });
  return { text: out, blocked };
}

module.exports = { priceGuard, parseAmount, REPLACEMENT };
