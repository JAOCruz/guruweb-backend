const { transitionTo, updateData } = require('../stateManager');
const { MSG } = require('../messages');
const { searchKnowledge, formatTopicResult, formatInstitutionResult, formatSearchResults } = require('../../knowledge/search');
const LEGAL_TOPICS = require('../../knowledge/legalTopics');
const INSTITUTIONS = require('../../knowledge/institutions');
const config = require('../../config');

const TOPIC_MENU_ITEMS = [
  { key: 'interdiccion', label: 'Interdicción en contratos' },
  { key: 'concubinato', label: 'Concubinato y declaración jurada' },
  { key: 'divorcio', label: 'Divorcio por mutuo consentimiento' },
  { key: 'poderes', label: 'Poderes notariales' },
  { key: 'acto_notoriedad', label: 'Acto de notoriedad y fe pública' },
  { key: 'venta_vehiculo', label: 'Venta de vehículo' },
  { key: 'venta_inmueble', label: 'Venta de inmueble' },
  { key: 'anticresis_prenda', label: 'Anticresis y prenda' },
  { key: 'notificaciones', label: 'Notificaciones y citaciones' },
];

async function handle(session, text) {
  const step = session.step;

  switch (step) {
    case 'menu': {
      const choice = parseInt(text.trim(), 10);

      // Option to search by keyword
      if (text.trim() === '0') {
        await transitionTo(session, 'main_menu', 'show', {});
        return MSG.MAIN_MENU;
      }

      // Numeric topic selection
      if (!isNaN(choice) && choice >= 1 && choice <= TOPIC_MENU_ITEMS.length) {
        const item = TOPIC_MENU_ITEMS[choice - 1];
        const topic = LEGAL_TOPICS[item.key];
        await transitionTo(session, 'legal_info', 'post_topic', { lastTopic: item.key });
        return formatTopicResult(topic) + '\n\n' + POST_TOPIC_MENU;
      }

      // Search by text (10 = institutions, 11 = free search)
      if (choice === 10) {
        await transitionTo(session, 'legal_info', 'institutions');
        return buildInstitutionsMenu();
      }

      if (choice === 11) {
        await transitionTo(session, 'legal_info', 'search');
        return `🔍 Escriba su *pregunta legal* o *tema de interés* y buscaremos en nuestra base de conocimientos.`;
      }

      // If user typed text instead of a number, try to search
      return await handleSearch(session, text);
    }

    case 'search': {
      return await handleSearch(session, text);
    }

    case 'institutions': {
      const choice = parseInt(text.trim(), 10);
      const instKeys = Object.keys(INSTITUTIONS);

      if (choice === 0) {
        await transitionTo(session, 'legal_info', 'menu');
        return buildTopicMenu();
      }

      if (!isNaN(choice) && choice >= 1 && choice <= instKeys.length) {
        const inst = INSTITUTIONS[instKeys[choice - 1]];
        await transitionTo(session, 'legal_info', 'post_topic', {});
        return formatInstitutionResult(inst) + '\n\n' + POST_TOPIC_MENU;
      }

      return 'Por favor, seleccione un número válido de la lista.';
    }

    case 'post_topic': {
      const choice = text.trim();
      if (choice === '1') {
        await transitionTo(session, 'legal_info', 'menu');
        return buildTopicMenu();
      }
      if (choice === '2') {
        await transitionTo(session, 'legal_info', 'search');
        return `🔍 Escriba su *pregunta legal* o *tema de interés*.`;
      }
      if (choice === '3') {
        await transitionTo(session, 'main_menu', 'show', {});
        return MSG.MAIN_MENU;
      }
      return MSG.INVALID_OPTION;
    }

    default:
      await transitionTo(session, 'legal_info', 'menu');
      return buildTopicMenu();
  }
}

async function handleSearch(session, text) {
  const results = searchKnowledge(text);

  // Try LLM-enhanced response if enabled
  if (config.gemini.enabled) {
    const { generateLegalResponse } = require('../../llm/generate');

    // Build context from knowledge base results to ground the LLM
    let context = '';
    if (results.length > 0) {
      const top = results[0];
      if (top.type === 'legal_topic') {
        context = top.data.content.replace(/[*_]/g, '');
        if (top.data.law_refs) {
          context += ' Base legal: ' + top.data.law_refs.join(', ');
        }
      } else if (top.type === 'institution') {
        context = `${top.data.name}: ${top.data.description}. URL: ${top.data.url}`;
      }
    }

    const llmResponse = await generateLegalResponse(text, context);
    if (llmResponse) {
      await transitionTo(session, 'legal_info', 'post_topic', {});
      return llmResponse + '\n\n' + POST_TOPIC_MENU;
    }
  }

  // Fallback: existing static knowledge base response
  if (results.length === 0) {
    await transitionTo(session, 'legal_info', 'post_topic', {});
    return `No encontramos resultados para "${text}".\n\n` +
      `Le recomendamos seleccionar un tema del menú o comunicarse con uno de nuestros abogados para una consulta personalizada.\n\n` +
      POST_TOPIC_MENU;
  }

  const formatted = formatSearchResults(results, 2);
  await transitionTo(session, 'legal_info', 'post_topic', {});
  return formatted + '\n\n' + POST_TOPIC_MENU;
}

function numLabel(n) {
  if (n === 0) return '0️⃣';
  if (n <= 9) return `${n}️⃣`;
  return `*${n}.*`;
}

function buildTopicMenu() {
  let text = `📚 *Base de Conocimientos Legales — República Dominicana*\n\n` +
    `Seleccione un tema para obtener información detallada:\n\n`;

  TOPIC_MENU_ITEMS.forEach((item, i) => {
    text += `${numLabel(i + 1)} ${item.label}\n`;
  });

  text += `\n${numLabel(10)} Instituciones gubernamentales y enlaces útiles\n`;
  text += `${numLabel(11)} Buscar por palabra clave\n`;
  text += `0️⃣ Regresar al menú principal`;

  return text;
}

function buildInstitutionsMenu() {
  const keys = Object.keys(INSTITUTIONS);
  let text = `🏛️ *Instituciones y Enlaces Útiles — RD*\n\n`;

  keys.forEach((key, i) => {
    const inst = INSTITUTIONS[key];
    text += `${numLabel(i + 1)} ${inst.name}\n`;
  });

  text += `\n0️⃣ Regresar al menú de temas`;
  return text;
}

const POST_TOPIC_MENU =
  `¿Qué desea hacer?\n\n` +
  `1️⃣ Ver otros temas legales\n` +
  `2️⃣ Buscar otro tema\n` +
  `3️⃣ Regresar al menú principal`;

module.exports = { handle, buildTopicMenu };
