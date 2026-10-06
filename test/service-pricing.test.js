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
