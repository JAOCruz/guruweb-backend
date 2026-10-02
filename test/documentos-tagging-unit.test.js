const test = require('node:test');
const assert = require('node:assert/strict');
const { alignTagged, normalizeKey, tagsInText } = require('../src/documentos/tagging');

const ORIGINAL = 'el señor JUAN PEREZ, de nacionalidad dominicana, cédula 001-0000000-1, domicilio Santo Domingo; y el señor PEDRO DIAZ, domicilio Santo Domingo.';

test('aligns a rewritten paragraph: the gaps between the literal text are the sample values', () => {
  const rewritten = 'el señor {{NOMBRE_VENDEDOR}}, de nacionalidad {{NACIONALIDAD_VENDEDOR}}, cédula {{DOCUMENTO IDENTIDAD_VENDEDOR}}, domicilio {{DOMICILIO_VENDEDOR}}; y el señor {{NOMBRE_COMPRADOR}}, domicilio {{DOMICILIO_COMPRADOR}}.';
  const spans = alignTagged(ORIGINAL, rewritten);
  assert.deepEqual(spans.map((s) => [s.key, s.value]), [
    ['NOMBRE_VENDEDOR', 'JUAN PEREZ'],
    ['NACIONALIDAD_VENDEDOR', 'dominicana'],
    ['DOCUMENTO IDENTIDAD_VENDEDOR', '001-0000000-1'],
    ['DOMICILIO_VENDEDOR', 'Santo Domingo'],
    ['NOMBRE_COMPRADOR', 'PEDRO DIAZ'],
    ['DOMICILIO_COMPRADOR', 'Santo Domingo'],
  ]);
  // the same value twice gets two different tags, each at its own place
  assert.equal(ORIGINAL.slice(spans[3].start, spans[3].end), 'Santo Domingo');
  assert.ok(spans[5].start > spans[3].end);
});

test('a tag at the start or end of the paragraph aligns', () => {
  const spans = alignTagged('JUAN PEREZ vende a PEDRO', '{{NOMBRE_VENDEDOR}} vende a {{NOMBRE_COMPRADOR}}');
  assert.deepEqual(spans.map((s) => [s.key, s.start, s.end]), [['NOMBRE_VENDEDOR', 0, 10], ['NOMBRE_COMPRADOR', 19, 24]]);
});

test('refuses when the AI changed the legal wording', () => {
  assert.equal(alignTagged(ORIGINAL, 'el sr. {{NOMBRE_VENDEDOR}}, de nacionalidad dominicana, cédula 001-0000000-1, domicilio Santo Domingo; y el señor PEDRO DIAZ, domicilio Santo Domingo.'), null);
  assert.equal(alignTagged('Vende JUAN', 'Vende {{NOMBRE}} hoy'), null);
});

test('refuses adjacent tags (no text between them to know where one ends) and empty values', () => {
  assert.equal(alignTagged('JUAN PEREZ', '{{NOMBRE}}{{APELLIDO}}'), null);
  assert.equal(alignTagged('Vende a , hoy', 'Vende a {{NOMBRE}}, hoy'), null);
});

test('no tags in the rewrite → nothing to do', () => {
  assert.deepEqual(alignTagged('PRIMERO: texto', 'PRIMERO: texto'), []);
});

test('tag keys are normalized', () => {
  assert.equal(normalizeKey(' nombre_vendedor '), 'NOMBRE_VENDEDOR');
  assert.equal(normalizeKey('Cédula del Comprador!'), 'CÉDULA DEL COMPRADOR');
  assert.equal(normalizeKey('{{x}}'), 'X');
  assert.equal(normalizeKey(''), '');
  assert.equal(tagsInText('a {{UNO}} b {{DOS}} {{UNO}}').join(','), 'UNO,DOS,UNO');
});
