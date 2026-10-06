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
