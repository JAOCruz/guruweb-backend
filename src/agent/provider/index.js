const { createFakeProvider } = require('./fake');

let fakeProvider = null;
function setFakeProvider(p) { fakeProvider = p; }

function isQuotaError(err) {
  if (!err) return false;
  if (err.status === 429 || err.code === 429) return true;
  const msg = `${err.message || ''} ${err.statusText || ''}`;
  return /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(msg);
}

function withTimeout(promise, timeoutMs = 25000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new Error('Tiempo agotado'); e.code = 'TIMEOUT'; reject(e); }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function getProvider(name = process.env.BOT_AI_PROVIDER || 'gemini') {
  if (name === 'fake') {
    if (!fakeProvider) throw new Error('No hay proveedor fake registrado (use setFakeProvider)');
    return fakeProvider;
  }
  if (name === 'gemini') return { name, chat: (req) => require('./gemini').chat(req) };
  if (name === 'claude') return { name, chat: (req) => require('./claude').chat(req) };
  throw new Error(`Proveedor desconocido: ${name}`);
}

module.exports = { getProvider, createFakeProvider, setFakeProvider, isQuotaError, withTimeout };
