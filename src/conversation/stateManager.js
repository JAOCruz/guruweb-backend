const ConversationSession = require('../models/ConversationSession');
const Client = require('../models/Client');
const { detectIntent } = require('./nlp');
const { MSG } = require('./messages');

// Global commands that override any flow
const GLOBAL_INTENTS = new Set(['menu', 'help', 'goodbye']);

async function getOrCreateSession(phone) {
  let session = await ConversationSession.findActive(phone);
  if (session) return session;

  const client = await Client.findByPhone(phone);
  session = await ConversationSession.create(phone, client?.id || null);
  return session;
}

async function transitionTo(session, flow, step, extraData = {}) {
  const data = { ...session.data, ...extraData };
  return ConversationSession.update(session.id, { flow, step, data });
}

async function updateData(session, newData) {
  const data = { ...session.data, ...newData };
  return ConversationSession.update(session.id, { flow: session.flow, step: session.step, data });
}

function checkGlobalCommand(text) {
  const intent = detectIntent(text);
  if (GLOBAL_INTENTS.has(intent)) return intent;
  return null;
}

async function handleGlobalCommand(intent, session) {
  switch (intent) {
    case 'menu':
      await transitionTo(session, 'main_menu', 'show');
      return MSG.MAIN_MENU;
    case 'help':
      return MSG.HELP;
    case 'goodbye':
      await ConversationSession.close(session.id);
      return MSG.GOODBYE;
    default:
      return null;
  }
}

async function resetToMenu(session) {
  return transitionTo(session, 'main_menu', 'show');
}

module.exports = {
  getOrCreateSession,
  transitionTo,
  updateData,
  checkGlobalCommand,
  handleGlobalCommand,
  resetToMenu,
};
