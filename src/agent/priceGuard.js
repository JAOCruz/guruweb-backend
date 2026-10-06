// Filtro de precios: un monto en la respuesta del modelo solo pasa si salió de una herramienta en esta conversación.
// Un monto es dinero solo cuando lleva moneda, antes ("RD$ 1,500", "RD$1500", "$1500", "RD $950", "US$100", "DOP 1,500")
// o después ("1,500 pesos", "1,500 RD$", "1,500 RD", "1500 DOP"), con "mil" opcional ("2 mil pesos", "RD$5 mil").
// Cédulas, fechas, horas, teléfonos, porcentajes y cantidades sin moneda no se tocan.
const REPLACEMENT = '(se lo confirmo)';

// Número "suelto": dígitos con separadores . , y espacio (el espacio solo si le sigue un grupo de 3 cifras: "1 500").
// Es permisivo a propósito: un grupo mal formado ("1,5000") se toma completo y se bloquea entero.
const NUM = '\\d(?:[\\d.,]|\\s(?=\\d{3}(?!\\d)))*';
const PREFIX = '(?:(?:RD|US)\\s?\\$\\s?|\\$\\s?|DOP\\s?)';
const POSTFIX = '(?:\\s?(?:pesos|RD\\$|RD|DOP))';
const MIL = '(?:\\s?(mil)\\b)?';
const MONEY = new RegExp(
  `${PREFIX}(${NUM})${MIL}(?:\\s?pesos\\b)?` +                      // grupos 1 (número) y 2 ("mil")
  `|(?<![\\d.,\\-$])(${NUM})${MIL}${POSTFIX}(?![A-Za-z0-9$])`,       // grupos 3 (número) y 4 ("mil")
  'gi');

// "1,500" → 1500; "1,500.00" → 1500; "1.500" → 1500; "1.500,50" → 1500.5; "1 500" → 1500; "950.50" → 950.5; "12,5" → 12.5.
// Devuelve null si el formato está mal ("1,5000", "1,500.000").
function parseAmount(s) {
  let t = String(s).trim().replace(/[.,\s]+$/, '');
  if (/^\d{1,3}(\s\d{3})+([.,]\d{1,2})?$/.test(t)) t = t.replace(/\s/g, '');
  if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) return Number(t.replace(/,/g, ''));
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) return Number(t.replace(/\./g, '').replace(',', '.'));
  if (/^\d+([.,]\d{1,2})?$/.test(t)) return Number(t.replace(',', '.'));
  return null;
}

// Se comparan en centavos para que RD$1,500 == 1500 == 1500.00.
const cents = (n) => Math.round(Number(n) * 100);

function priceGuard(text, allowed = new Set()) {
  const ok = new Set([...allowed].filter((n) => Number.isFinite(Number(n))).map(cents));
  const blocked = [];
  const out = String(text == null ? '' : text).replace(MONEY, (match, n1, mil1, n2, mil2) => {
    const raw = n1 !== undefined ? n1 : n2;
    const mil = n1 !== undefined ? mil1 : mil2;
    const factor = mil ? 1000 : 1;
    const parsed = parseAmount(raw);
    // Separadores que el número arrastró al final ("RD$950.") no son parte del monto: se conservan.
    const tail = (raw.match(/[.,\s]+$/) || [''])[0];
    const keep = tail && match.endsWith(tail) ? tail : '';
    if (parsed !== null && ok.has(cents(parsed * factor))) return match;
    blocked.push((parsed !== null ? parsed : Number(raw.replace(/\D/g, '')) || 0) * factor);
    return REPLACEMENT + keep;
  });
  return { text: out, blocked };
}

module.exports = { priceGuard, parseAmount, REPLACEMENT };
