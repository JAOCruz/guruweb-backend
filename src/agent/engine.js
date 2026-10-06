// Qué motor responde un chat: el agente (Task 8) o el motor viejo (src/conversation/router.js).
// BOT_ENGINE=agent manda todos los chats al agente; BOT_AGENT_PHONES (lista separada por comas) manda
// esos teléfonos al agente aunque BOT_ENGINE sea legacy. Las variables se leen en cada llamada, no al
// cargar el módulo, para que un cambio en Railway (o en una prueba) aplique sin reiniciar.

// Mismo criterio que el handler: sin sufijos de WhatsApp (@s.whatsapp.net, @lid) y solo dígitos.
function normalizePhone(phone) {
  return String(phone || '').replace(/@s\.whatsapp\.net$|@lid$/g, '').replace(/\D/g, '');
}

function agentPhones() {
  return new Set(String(process.env.BOT_AGENT_PHONES || '').split(',').map(normalizePhone).filter(Boolean));
}

/** @returns {'agent'|'legacy'} */
function engineFor(phone) {
  if (process.env.BOT_ENGINE === 'agent') return 'agent';
  return agentPhones().has(normalizePhone(phone)) ? 'agent' : 'legacy';
}

module.exports = { engineFor, normalizePhone };
