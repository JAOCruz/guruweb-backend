const ConversationSession = require('../models/ConversationSession');
const Client = require('../models/Client');
const Message = require('../models/Message');
const { detectIntent } = require('./nlp');
const { MSG } = require('./messages');

// Global commands that override any flow
const GLOBAL_INTENTS = new Set(['menu', 'help', 'goodbye']);

async function getOrCreateSession(phone) {
  let session = await ConversationSession.findActive(phone);
  if (session) return session;

  const client = await Client.findByPhone(phone);

  // If this phone already has conversation history, resume in menu-ready state
  // instead of restarting with the welcome greeting.
  const priorMessages = await Message.findRecentByPhone(phone, 1);
  const initialStep = priorMessages.length > 0 ? 'show' : 'init';

  session = await ConversationSession.create(phone, client?.id || null, initialStep);
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
