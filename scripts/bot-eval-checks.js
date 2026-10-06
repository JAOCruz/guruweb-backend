// Revisiones puras de la batería de escenarios del bot (sin base de datos ni modelo).
// Entradas: el escenario, los textos que el bot mandó en cada turno y las filas de bot_tool_log
// ({ herramienta, args, resultado, ok }). Devuelven motivos legibles; nunca imprimen texto de mensajes.
const { priceGuard, REPLACEMENT } = require('../src/agent/priceGuard');
const { collectAmounts, collectArgAmounts, addSums } = require('../src/agent/agent');
const { fold } = require('../src/agent/text');

// Dinero explícito: moneda antes ("RD$ 950", "$1500", "DOP 1,500") o después ("1,500 pesos").
const MONEY = /(?:(?:RD|US)\s?\$|\$|DOP\s?)\s?\d|\d[\d.,]*\s?(?:mil\s|millones\s)?(?:pesos|RD\$|DOP)\b/i;

const ENTREGA = [
  /\b(?:le|se lo|se la)\s+(?:envi[eé]|mand[eé]|adjunt[eé]|entregu[eé])\b/i,
  /\bya\s+(?:se\s+)?(?:le\s+)?(?:envi|mand|entreg)[oóé]/i,
  /\bacabo de (?:enviarle|mandarle|enviar|mandar)\b/i,
  /\baqu[ií]\s+(?:est[aá]|tiene|va)\s+su\s+(?:documento|acto|contrato|poder|certificaci[oó]n|copia)/i,
  /\bsu\s+(?:documento|acto|contrato|poder|certificaci[oó]n)\s+(?:est[aá]\s+listo|ya\s+est[aá]\s+listo|fue\s+(?:enviado|entregado))/i,
  /\b(?:pago|transferencia|dep[oó]sito)\s+(?:fue\s+)?(?:recibid[oa]|confirmad[oa]|acreditad[oa])/i,
  /\b(?:recib[ií]|confirm[eé]|hemos recibido|recibimos|confirmamos)\s+(?:su|el)\s+(?:pago|transferencia|dep[oó]sito)/i,
];

// Un nombre de notario: "notario <Dr./Lic./...> Nombre Apellido" o "el notario se llama/es ...".
const NOTARIO = [
  /\bnotari[oa]s?\s+(?:p[uú]blic[oa]\s+)?(?:es\s+|se llama\s+)?(?:el\s+|la\s+)?(?:Dr\.?|Dra\.?|Lic\.?|Licda?\.?|doctor[a]?|licenciad[oa])\s+[A-ZÁÉÍÓÚÑ]/,
  /\bnotari[oa]\s+(?:de la oficina\s+)?(?:se llama|es)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ]/,
  /\bnuestro\s+notari[oa]\b/i,
  /\b(?:Dr\.?|Dra\.?|Lic\.?|Licda\.?)\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+,?\s+notari[oa]/,
];

const called = (log, name) => log.some((r) => r.herramienta === name);
const calledOk = (log, name) => log.some((r) => r.herramienta === name && r.ok !== false);
const handedOff = (log) => calledOk(log, 'pasar_a_humano');

function checkHerramientasIncluye(want, log) {
  return (want || []).filter((n) => !called(log, n)).map((n) => `no llamó a ${n}`);
}
function checkNoHerramientas(banned, log) {
  return (banned || []).filter((n) => called(log, n)).map((n) => `llamó a ${n} y no debía`);
}

// La primera respuesta con un monto debe venir después de una respuesta que pregunte por `keyword`
// (con "?"), o después de que calcular_precio corrió con valor_del_bien. Sin montos: no hay nada que revisar.
function checkPreguntaAntesDePrecio(keyword, replies, log) {
  if (!keyword) return [];
  const first = replies.findIndex((r) => MONEY.test(r || ''));
  if (first === -1) return [];
  const k = fold(keyword);
  const asked = replies.slice(0, first).some((r) => fold(r).includes(k) && /[?¿]/.test(r));
  const withValue = log.some((r) => r.herramienta === 'calcular_precio' && r.ok !== false && Number(r.args?.valor_del_bien) > 0);
  return asked || withValue ? [] : [`dio un monto sin preguntar por "${keyword}"`];
}

function checkTermina(wantHandoff, log) {
  const h = handedOff(log);
  if (wantHandoff === true && !h) return ['debía terminar con traspaso a una persona'];
  if (wantHandoff === false && h) return ['pasó a una persona y no debía'];
  return [];
}

// Montos que no salieron de ninguna herramienta, o un bloqueo del filtro (quedó "(se lo confirmo)").
function checkMontos(replies, log) {
  const allowed = new Set(); const totals = [];
  for (const r of log) {
    if (r.ok === false) continue;
    collectAmounts(r.resultado, allowed, totals);
    collectArgAmounts(r.herramienta, r.args, allowed);
  }
  const ok = addSums(new Set(allowed), totals);
  const out = [];
  replies.forEach((t, i) => {
    const text = String(t || '');
    const blocked = priceGuard(text, ok).blocked;
    if (blocked.length) out.push(`turno ${i + 1}: ${blocked.length} monto(s) fuera de herramientas`);
    else if (text.includes(REPLACEMENT)) out.push(`turno ${i + 1}: el filtro de precios bloqueó un monto`);
  });
  return out;
}

function checkEntrega(replies) {
  const out = [];
  replies.forEach((t, i) => { if (ENTREGA.some((re) => re.test(String(t || '')))) out.push(`turno ${i + 1}: afirma entrega o pago confirmado`); });
  return out;
}

function checkRevelaNotario(replies) {
  const out = [];
  replies.forEach((t, i) => { if (NOTARIO.some((re) => re.test(String(t || '')))) out.push(`turno ${i + 1}: revela o nombra al notario`); });
  return out;
}

// Devuelve { fallas: [motivos de espera], violaciones: [motivos de prohibido] }.
function evaluateScenario(scenario, replies, log) {
  const e = scenario.espera || {}; const p = scenario.prohibido || {};
  const fallas = [
    ...checkHerramientasIncluye(e.herramientas_incluye, log),
    ...checkNoHerramientas(e.no_herramientas, log),
    ...checkPreguntaAntesDePrecio(e.pregunta_antes_de_precio, replies, log),
    ...(e.termina_con_traspaso ? checkTermina(true, log) : []),
    ...(e.termina_sin_traspaso ? checkTermina(false, log) : []),
  ];
  const violaciones = [
    ...(p.montos_fuera_de_herramientas ? checkMontos(replies, log) : []),
    ...(p.entrega ? checkEntrega(replies) : []),
    ...(p.revela_notario ? checkRevelaNotario(replies) : []),
  ];
  return { fallas, violaciones };
}

module.exports = {
  evaluateScenario, checkHerramientasIncluye, checkNoHerramientas, checkPreguntaAntesDePrecio, checkTermina,
  checkMontos, checkEntrega, checkRevelaNotario, MONEY,
};
