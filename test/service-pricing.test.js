const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePrice } = require('../src/models/servicePricing');

const ACTO = { digitacion_price: '250', notarizacion_price: '500', price_tiers: [
  { min: 0, max: 100000, price: 500 }, { min: 100001, max: 800000, price: 700 },
  { min: 3000001, max: 5000000, price: 3000, por_confirmar: true }, { min: 5000001, max: null, price: 5000, por_confirmar: true }] };
test('acto de venta de 500K: digitación 250 + tramo 700 = 950', () => {
  assert.deepEqual(calculatePrice(ACTO, { assetValue: 500000 }).total, 950);
});
test('un tramo por confirmar no da monto', () => {
  const r = calculatePrice(ACTO, { assetValue: 4000000 });
  assert.equal(r.total, null); assert.equal(r.porConfirmar, true);
});
test('un servicio por confirmar no da monto aunque tenga precio', () => {
  assert.equal(calculatePrice({ digitacion_price: '1000', por_confirmar: true }).total, null);
});
test('sin ningún precio el total es null, no 0', () => {
  assert.equal(calculatePrice({ digitacion_price: null, notarizacion_price: null }).total, null);
});
test('cantidad multiplica y el rango se devuelve', () => {
  const r = calculatePrice({ digitacion_price: '250', precio_rango: { min: 250, max: 300 } }, { quantity: 2 });
  assert.equal(r.total, 500); assert.deepEqual(r.rango, { min: 250, max: 300 });
});

// ---------- tramos: el precio depende del valor del bien ----------

// Como "Contrato de Venta Bienes" en el catálogo: tramos sin notarizacion_price base.
const CONTRATO = { digitacion_price: '300', notarizacion_price: null, price_tiers: [
  { min: 0, max: 1000000, price: 1000 }, { min: 1000001, max: 3000000, price: 2000 },
  { min: 3000001, max: null, price: 3000, por_confirmar: true }] };
test('tramos sin notarización base (Contrato de Venta Bienes): 200k → 300 + 1000', () => {
  const r = calculatePrice(CONTRATO, { assetValue: 200000 });
  assert.equal(r.total, 1300); assert.equal(r.tramo, '0-1000000'); assert.equal(r.falta, null);
  assert.deepEqual(r.breakdown, { digitacion: 300, notarizacion: 1000 });
});
test('tramos sin notarización base: 4M queda por confirmar, no la digitación sola', () => {
  const r = calculatePrice(CONTRATO, { assetValue: 4000000 });
  assert.equal(r.total, null); assert.equal(r.porConfirmar, true);
});
test('un servicio por tramos sin valor del bien no da monto: falta valor_del_bien', () => {
  for (const s of [ACTO, CONTRATO]) {
    const r = calculatePrice(s);
    assert.equal(r.total, null); assert.equal(r.falta, 'valor_del_bien'); assert.equal(r.porConfirmar, false);
    assert.equal(r.dependeDelValor, true);
  }
  assert.equal(calculatePrice({ digitacion_price: '700' }).falta, null);
  assert.equal(calculatePrice({ digitacion_price: '700' }).dependeDelValor, false);
});
test('un valor que no cae en ningún tramo (hueco) queda por confirmar', () => {
  const r = calculatePrice(ACTO, { assetValue: 900000 }); // entre 800000 y 3000001 no hay tramo
  assert.equal(r.total, null); assert.equal(r.porConfirmar, true); assert.equal(r.falta, null);
});
test('sin notarización, un servicio por tramos da solo la digitación aunque no haya valor', () => {
  const r = calculatePrice(ACTO, { includeNotarization: false });
  assert.equal(r.total, 250); assert.equal(r.falta, null);
});

// ---------- precio por foja y duplicados ----------

test('por foja: legal simple de 2 fojas estimadas = 500 + notarización', () => {
  const r = calculatePrice({ foja_tipo: 'legal_simple', fojas: 2, notarizacion_price: '500' });
  assert.equal(r.total, 1000); assert.equal(r.fojas, 2);
  assert.equal(r.tarifaPorFoja, 250); assert.equal(r.fojasEstimadas, true);
});
test('por foja: las fojas pasadas mandan y ya no son estimadas', () => {
  const r = calculatePrice({ foja_tipo: 'legal_simple', fojas: 2, notarizacion_price: '500' }, { fojas: 3 });
  assert.equal(r.breakdown.digitacion, 750); assert.equal(r.fojas, 3);
  assert.equal(r.fojasEstimadas, false);
});
test('por foja ignora digitacion_price y multiplica por cantidad', () => {
  const r = calculatePrice({ foja_tipo: 'carta_simple', digitacion_price: '999', fojas: 1 }, { quantity: 2 });
  assert.equal(r.total, 300);
});
test('por foja con tramos: acto de venta de 2 fojas en 500K = 500 + 700', () => {
  const r = calculatePrice({ ...ACTO, foja_tipo: 'legal_simple', fojas: 2 }, { assetValue: 500000 });
  assert.equal(r.total, 1200);
});
test('por foja con tramos y sin valor del bien pide el valor', () => {
  const r = calculatePrice({ ...ACTO, foja_tipo: 'legal_simple', fojas: 2 });
  assert.equal(r.total, null); assert.equal(r.falta, 'valor_del_bien');
});
test('por foja por confirmar no da monto', () => {
  assert.equal(calculatePrice({ foja_tipo: 'legal_simple', fojas: 2, por_confirmar: true }).total, null);
});
test('fojas inválidas (0, -1, 1.5, "x") cuentan como no dadas', () => {
  for (const bad of [0, -1, 1.5, 'x']) {
    const a = calculatePrice({ foja_tipo: 'legal_simple', fojas: 2 }, { fojas: bad });
    assert.equal(a.fojas, 2); assert.equal(a.breakdown.digitacion, 500);
    const b = calculatePrice({ foja_tipo: 'legal_simple' }, { fojas: bad });
    assert.equal(b.fojas, 1); assert.equal(b.breakdown.digitacion, 250);
  }
});
test('duplicados: 1–2 fojas a 500, 3+ a 700, suma al total y al desglose', () => {
  const s2 = calculatePrice({ foja_tipo: 'legal_simple', fojas: 2 }, { duplicados: 2 });
  assert.equal(s2.breakdown.duplicados, 1000); assert.equal(s2.total, 500 + 1000);
  const s3 = calculatePrice({ foja_tipo: 'legal_simple', fojas: 2 }, { fojas: 3, duplicados: 1 });
  assert.equal(s3.breakdown.duplicados, 700); assert.equal(s3.total, 750 + 700);
  const fijo = calculatePrice({ digitacion_price: '250' }, { fojas: 3, duplicados: 1 });
  assert.equal(fijo.breakdown.duplicados, 700); assert.equal(fijo.total, 950);
  assert.deepEqual(calculatePrice({ digitacion_price: '250' }).breakdown, { digitacion: 250, notarizacion: 0 });
});
