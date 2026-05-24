// Build a WhatsApp list message for Baileys
function buildListMessage(bodyText, buttonLabel, sections) {
  return {
    text: bodyText,
    footer: 'Gurú Soluciones',
    title: '',
    buttonText: buttonLabel,
    sections,
  };
}

// Wrap a text response with a list message for interactive menus
function withList(text, listMessage) {
  return { text, listMessage };
}

module.exports = { buildListMessage, withList };
