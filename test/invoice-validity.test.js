process.env.RAILWAY_VOLUME_MOUNT_PATH = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'guru-validity-'));
const test = require('node:test');
const assert = require('node:assert/strict');
const { validityNote } = require('../src/documents/generateInvoice');

test('la cotización dice que es válida por 7 días; la factura no', () => {
  assert.equal(validityNote('COTIZACIÓN'), 'Cotización válida por 7 días a partir de su fecha.');
  assert.equal(validityNote('COTIZACION'), 'Cotización válida por 7 días a partir de su fecha.');
  assert.equal(validityNote('FACTURA'), '');
});
