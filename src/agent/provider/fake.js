// Proveedor guionado para pruebas: devuelve cada paso en orden y guarda lo recibido.
function createFakeProvider(script = [], { search } = {}) {
  const calls = [];
  let i = 0;
  const p = {
    name: 'fake',
    calls,
    async chat(req) {
      calls.push(req);
      if (i >= script.length) throw new Error('fake provider: guion agotado');
      const step = script[i++];
      const out = typeof step === 'function' ? step(req.messages) : step;
      return { text: (out && out.text) || '', toolCalls: (out && out.toolCalls) || [] };
    },
  };
  // search solo existe si la prueba lo pasa (así se prueba la ruta "proveedor sin búsqueda").
  if (typeof search === 'function') p.search = search;
  return p;
}
module.exports = { createFakeProvider };
