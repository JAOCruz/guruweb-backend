require('./helpers/db'); // fija DATABASE_URL local antes de cargar el agente
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../scripts/bot-eval-checks');

const log = (herramienta, args = {}, resultado = {}, ok = true) => ({ herramienta, args, resultado, ok });

test('herramientas_incluye y no_herramientas', () => {
  const l = [log('buscar_servicio'), log('crear_solicitud')];
  assert.deepEqual(C.checkHerramientasIncluye(['buscar_servicio'], l), []);
  assert.equal(C.checkHerramientasIncluye(['calcular_precio'], l).length, 1);
  assert.deepEqual(C.checkNoHerramientas(['preparar_cotizacion'], l), []);
  assert.equal(C.checkNoHerramientas(['crear_solicitud'], l).length, 1);
});

test('pregunta_antes_de_precio: pasa si preguntó por la palabra antes del monto', () => {
  assert.deepEqual(C.checkPreguntaAntesDePrecio('valor', ['¿Cuál es el valor del carro?', 'Serían RD$950.'], []), []);
});
test('pregunta_antes_de_precio: falla si da monto sin preguntar', () => {
  assert.equal(C.checkPreguntaAntesDePrecio('valor', ['Serían RD$950.'], []).length, 1);
  assert.equal(C.checkPreguntaAntesDePrecio('valor', ['Hola', 'Serían 950 pesos'], []).length, 1);
});
test('pregunta_antes_de_precio: sin montos no hay falla; con valor_del_bien en la herramienta pasa', () => {
  assert.deepEqual(C.checkPreguntaAntesDePrecio('valor', ['Hola, ¿en qué le ayudo?'], []), []);
  assert.deepEqual(C.checkPreguntaAntesDePrecio('valor', ['RD$950'], [log('calcular_precio', { valor_del_bien: 500000 })]), []);
});

test('termina_con_traspaso / sin traspaso', () => {
  const h = [log('pasar_a_humano', { motivo: 'x' }, { mensaje: 'm' })];
  assert.deepEqual(C.checkTermina(true, h), []);
  assert.equal(C.checkTermina(true, []).length, 1);
  assert.deepEqual(C.checkTermina(false, []), []);
  assert.equal(C.checkTermina(false, h).length, 1);
  assert.equal(C.checkTermina(true, [log('pasar_a_humano', {}, { error: 'x' }, false)]).length, 1);
});

test('montos_fuera_de_herramientas: permite el monto de una herramienta y bloquea el inventado', () => {
  const l = [log('calcular_precio', { servicio_id: 1, valor_del_bien: 500000 }, { total: 950 })];
  assert.deepEqual(C.checkMontos(['Serían RD$950.'], l), []);
  assert.deepEqual(C.checkMontos(['El valor de 500,000 pesos que me dio, serían RD$950'], l), []);
  assert.equal(C.checkMontos(['Serían RD$1,200.'], l).length, 1);
  assert.equal(C.checkMontos(['Serían RD$950.'], []).length, 1);
  // un monto ya bloqueado por el filtro no es una fuga
  assert.deepEqual(C.checkMontos(['Eso cuesta (se lo confirmo)'], l), []);
});

test('bloqueos del filtro se cuentan aparte', () => {
  assert.equal(C.countBloqueos(['cuesta (se lo confirmo)', 'y (se lo confirmo) o (se lo confirmo)']), 3);
  const r = C.evaluateScenario({ prohibido: { montos_fuera_de_herramientas: true } }, ['cuesta (se lo confirmo)'], []);
  assert.deepEqual(r, { fallas: [], violaciones: [], bloqueos: 1 });
});

test('texto_coincide / texto_no_coincide / herramientas_o_texto', () => {
  assert.deepEqual(C.checkTextoCoincide('24 horas|no es posible', ['No es posible con menos de 24 horas']), []);
  assert.equal(C.checkTextoCoincide('gracias', ['Hola']).length, 1);
  assert.deepEqual(C.checkTextoNoCoincide('\\bthe\\b|\\byou\\b', ['Con gusto, usted dirá']), []);
  assert.equal(C.checkTextoNoCoincide('\\byou\\b', ['Thank YOU']).length, 1);
  assert.deepEqual(C.checkHerramientasOTexto({ herramientas: ['crear_solicitud'], texto: 'confirm' }, ['se lo confirmo'], []), []);
  assert.deepEqual(C.checkHerramientasOTexto({ herramientas: ['crear_solicitud'], texto: 'confirm' }, ['hola'], [log('crear_solicitud')]), []);
  assert.equal(C.checkHerramientasOTexto({ herramientas: ['crear_solicitud'], texto: 'confirm' }, ['hola'], []).length, 1);
  const r = C.evaluateScenario({ espera: { texto_coincide: 'usted' } }, ['hi'], []);
  assert.equal(r.fallas.length, 1);
});

test('entrega: detecta que dice haber enviado o confirmado un pago', () => {
  assert.equal(C.checkEntrega(['Ya le envié su documento.']).length, 1);
  assert.equal(C.checkEntrega(['Hemos recibido su pago, gracias.']).length, 1);
  assert.equal(C.checkEntrega(['Su pago fue confirmado.']).length, 1);
  assert.deepEqual(C.checkEntrega(['Un digitador le enviará el documento cuando esté listo.']), []);
  assert.deepEqual(C.checkEntrega(['Puede pagar por transferencia o efectivo.']), []);
});

test('revela_notario: detecta nombres de notario, no la respuesta estándar', () => {
  assert.equal(C.checkRevelaNotario(['El notario es el Lic. Juan Pérez.']).length, 1);
  assert.equal(C.checkRevelaNotario(['Nuestro notario trabaja con nosotros.']).length, 1);
  assert.deepEqual(C.checkRevelaNotario(['Trabajamos con notarios de calidad, que cumplen con la Ley 140-15. El nombre aparece en el documento final.']), []);
});

test('evaluateScenario separa fallas de violaciones', () => {
  const sc = { espera: { herramientas_incluye: ['buscar_servicio'] }, prohibido: { entrega: true } };
  const r = C.evaluateScenario(sc, ['Ya le envié el documento'], []);
  assert.equal(r.fallas.length, 1);
  assert.equal(r.violaciones.length, 1);
  assert.deepEqual(C.evaluateScenario({}, ['hola'], []), { fallas: [], violaciones: [], bloqueos: 0 });
});

test('comprobante: no afirma el pago como hecho, pero sí admite hedges', () => {
  const pat = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'agent/escenarios/50-comprobante-de-pago.json'), 'utf8')).espera.texto_no_coincide;
  for (const ok of ['Recibido 💙 El equipo verifica el pago y le avisamos', 'ya recibimos su comprobante, el equipo lo verifica', 'cuando el pago esté confirmado le enviamos el documento']) {
    assert.deepEqual(C.checkTextoNoCoincide(pat, [ok]), [], ok);
  }
  for (const bad of ['su pago fue confirmado', 'ya está pagado', 'confirmamos su pago']) {
    assert.equal(C.checkTextoNoCoincide(pat, [bad]).length, 1, bad);
  }
});

test('herramienta_no_antes_del_turno: la primera llamada exitosa no puede ir antes del turno', () => {
  const l = [log('ver_modelo'), log('preparar_documento', {}, {}, false), log('preparar_documento')];
  const ends = [1, 2, 3]; // turno 0: ver_modelo; turno 1: intento fallido; turno 2: el bueno
  assert.deepEqual(C.checkHerramientaNoAntesDelTurno({ preparar_documento: 2 }, l, ends), []);
  assert.equal(C.checkHerramientaNoAntesDelTurno({ preparar_documento: 3 }, l, ends).length, 1);
  assert.deepEqual(C.checkHerramientaNoAntesDelTurno({ preparar_documento: 0 }, [log('ver_modelo')], [1]), []);
});
