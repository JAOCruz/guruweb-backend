// Proveedor guionado para pruebas: devuelve cada paso en orden y guarda lo recibido.
function createFakeProvider(script = []) {
  const calls = [];
  let i = 0;
  return {
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
}
module.exports = { createFakeProvider };
