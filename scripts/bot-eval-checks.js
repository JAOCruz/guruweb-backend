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

// Montos que llegaron al texto entregado sin salir de ninguna herramienta (el filtro del agente falló).
function allowedAmounts(log) {
  const allowed = new Set(); const totals = [];
  for (const r of log) {
    if (r.ok === false) continue;
    collectAmounts(r.resultado, allowed, totals);
    collectArgAmounts(r.herramienta, r.args, allowed);
  }
  return addSums(new Set(allowed), totals);
}
function checkMontos(replies, log) {
  const ok = allowedAmounts(log);
  const out = [];
  replies.forEach((t, i) => {
    const blocked = priceGuard(String(t || ''), ok).blocked;
    if (blocked.length) out.push(`turno ${i + 1}: ${blocked.length} monto(s) fuera de herramientas`);
  });
  return out;
}

// Cuántas veces el filtro de precios cambió un monto por "(se lo confirmo)": el filtro funcionó, es solo una advertencia.
function countBloqueos(replies) {
  return replies.reduce((n, t) => n + (String(t || '').split(REPLACEMENT).length - 1), 0);
}

// Texto de las respuestas del bot (regex, sin distinguir mayúsculas).
const joined = (replies) => replies.map((t) => String(t || '')).join('\n');
function checkTextoCoincide(pattern, replies) {
  return pattern && !new RegExp(pattern, 'i').test(joined(replies)) ? [`la respuesta no coincide con /${pattern}/`] : [];
}
function checkTextoNoCoincide(pattern, replies) {
  return pattern && new RegExp(pattern, 'i').test(joined(replies)) ? [`la respuesta coincide con /${pattern}/ y no debía`] : [];
}
// Basta una: alguna herramienta llamada o el texto coincide.
function checkHerramientasOTexto(spec, replies, log) {
  if (!spec) return [];
  const byTool = (spec.herramientas || []).some((n) => called(log, n));
  const byText = spec.texto && new RegExp(spec.texto, 'i').test(joined(replies));
  return byTool || byText ? [] : [`ni llamó a ${(spec.herramientas || []).join('/')} ni coincide con /${spec.texto}/`];
}

// herramienta_no_antes_del_turno: { herramienta: n } -> su primera llamada exitosa no puede ser antes del turno n (base 0).
// turnEnds[t] = cuántas filas de bot_tool_log había al terminar el turno t.
function checkHerramientaNoAntesDelTurno(spec, log, turnEnds) {
  const out = [];
  for (const [name, minTurn] of Object.entries(spec || {})) {
    const i = log.findIndex((r) => r.herramienta === name && r.ok !== false);
    if (i === -1) continue;
    const turn = (turnEnds || []).findIndex((end) => i < end);
    if (turn !== -1 && turn < minTurn) out.push(`llamó a ${name} en el turno ${turn + 1}, antes del turno ${minTurn + 1}`);
  }
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

// Devuelve { fallas, violaciones, bloqueos }: motivos de espera, motivos de prohibido y conteo de bloqueos del filtro.
function evaluateScenario(scenario, replies, log, turnEnds) {
  const e = scenario.espera || {}; const p = scenario.prohibido || {};
  const fallas = [
    ...checkHerramientasIncluye(e.herramientas_incluye, log),
    ...checkNoHerramientas(e.no_herramientas, log),
    ...checkPreguntaAntesDePrecio(e.pregunta_antes_de_precio, replies, log),
    ...(e.termina_con_traspaso ? checkTermina(true, log) : []),
    ...(e.termina_sin_traspaso ? checkTermina(false, log) : []),
    ...checkTextoCoincide(e.texto_coincide, replies),
    ...checkTextoNoCoincide(e.texto_no_coincide, replies),
    ...checkHerramientasOTexto(e.herramientas_o_texto, replies, log),
    ...checkHerramientaNoAntesDelTurno(e.herramienta_no_antes_del_turno, log, turnEnds),
  ];
  const violaciones = [
    ...(p.montos_fuera_de_herramientas ? checkMontos(replies, log) : []),
    ...(p.entrega ? checkEntrega(replies) : []),
    ...(p.revela_notario ? checkRevelaNotario(replies) : []),
  ];
  return { fallas, violaciones, bloqueos: countBloqueos(replies) };
}

module.exports = {
  evaluateScenario, checkHerramientasIncluye, checkNoHerramientas, checkPreguntaAntesDePrecio, checkTermina,
  checkMontos, countBloqueos, checkTextoCoincide, checkTextoNoCoincide, checkHerramientasOTexto, checkHerramientaNoAntesDelTurno, checkEntrega, checkRevelaNotario, MONEY,
};
