const Client = require('../models/Client');
const Case = require('../models/Case');
const { getOrCreateSession, transitionTo, checkGlobalCommand, handleGlobalCommand } = require('./stateManager');
const { MSG, LIST } = require('./messages');
const { withList } = require('../whatsapp/interactive');
const { detectIntent, isMenuChoice } = require('./nlp');
const { searchKnowledge, formatSearchResults } = require('../knowledge/search');
const config = require('../config');

const intakeFlow = require('./flows/intake');
const appointmentFlow = require('./flows/appointment');
const documentFlow = require('./flows/document');
const caseStatusFlow = require('./flows/caseStatus');
const legalInfoFlow = require('./flows/legalInfo');
const servicesFlow = require('./flows/services');
const docGenFlow = require('./flows/docGen');
const billingFlow = require('./flows/billing');
const { detectTemplateFromText } = require('../documents/templateFields');

// Steps that accept free text input — everything else only expects numbers
const FREE_TEXT_STEPS = new Set([
  'main_menu:init', 'main_menu:show',
  'intake:welcome_choice', 'intake:ask_name', 'intake:confirm_name', 'intake:ask_email',
  'intake:ask_address', 'intake:ask_case_type', 'intake:ask_description',
  'intake:ask_urgency', 'intake:quick_question', 'intake:confirm',
  'talk_to_lawyer:waiting',
  'case_status:ask_number', 'case_status:select_case',
  'legal_info:menu', 'legal_info:search',
  'document:ask_description', 'document:await_file',
  'appointment:ask_date',
  'doc_generation:confirm_template', 'doc_generation:collecting', 'doc_generation:generating',
  'billing:ask_services', 'billing:confirm_details', 'billing:quote_confirm',
]);

async function routeMessage(phone, text, msg, savedMedia = null) {
  const session = await getOrCreateSession(phone);

  // Check for global commands that override any flow
  const globalCmd = checkGlobalCommand(text);
  if (globalCmd && session.flow !== 'main_menu') {
    const response = await handleGlobalCommand(globalCmd, session);
    if (response) {
      if (globalCmd === 'menu') return withList(response, LIST.MAIN_MENU);
      return response;
    }
  }

  // In structured flows: if user sends free text at a number-only step,
  // respond with AI and return to main menu instead of "opción no válida"
  const flowStep = `${session.flow}:${session.step}`;
  const trimmed = text.trim();
  const isNumber = /^\d+$/.test(trimmed);
  if (!FREE_TEXT_STEPS.has(flowStep) && !isNumber && trimmed.length > 2) {
    console.log(`[Router] Free text in structured flow (${flowStep}): "${trimmed.substring(0, 50)}" — using smart fallback`);
    await transitionTo(session, 'main_menu', 'show');
    return await handleSmartFallback(session, text, savedMedia);
  }

  // Route to the active flow
  switch (session.flow) {
    case 'main_menu':
      return await handleMainMenu(session, text, msg, savedMedia);

    case 'intake':
      return await intakeFlow.handle(session, text, msg);

    case 'appointment':
      return await appointmentFlow.handle(session, text, msg);

    case 'document':
      return await documentFlow.handle(session, text, msg, savedMedia);

    case 'case_status':
      return await caseStatusFlow.handle(session, text);

    case 'legal_info':
      return await legalInfoFlow.handle(session, text);

    case 'services':
      return await servicesFlow.handle(session, text);

    case 'talk_to_lawyer':
      return await handleTalkToLawyer(session, text);

    case 'doc_generation':
      return await docGenFlow.handle(session, text, msg, savedMedia);

    case 'billing':
      return await billingFlow.handle(session, text, msg);

    default:
      await transitionTo(session, 'main_menu', 'init');
      return await handleMainMenu(session, text, msg, savedMedia);
  }
}

async function handleMainMenu(session, text, msg, savedMedia = null) {
  const step = session.step;

  // First-time interaction
  if (step === 'init') {
    const client = await Client.findByPhone(session.phone);

    if (client) {
      const ConversationSession = require('../models/ConversationSession');
      await ConversationSession.setClientId(session.id, client.id);
      session.client_id = client.id;
    }

    await transitionTo(session, 'main_menu', 'show');

    // If user sent something substantive (not just "hola" or a number),
    // process their actual message instead of ignoring it with a greeting
    const trimmed = text.trim();
    const isSubstantive = trimmed.length > 4 && !/^\d+$/.test(trimmed);

    if (isSubstantive) {
      // Only show the welcome menu for PURE greetings (hola, buenos días, etc.)
      // Everything else — process it directly, even on first contact
      const isPureGreeting = /^(hola|buenas?|buenos?\s*(días?|tardes?|noches?)|hey|hi|good\s*(morning|afternoon|evening)|saludos?|buen\s*día)\s*[!.?]*$/i.test(trimmed);

      if (!isPureGreeting) {
        console.log(`[Router] First message has intent — skipping menu, processing directly: "${trimmed.substring(0, 60)}"`);
        return await handleSmartFallback({ ...session, step: 'show' }, text, savedMedia);
      }
    }

    // Simple greeting or short text — respond naturally, never show numbered menu
    if (config.gemini.enabled) {
      const { generateGreeting } = require('../llm/generate');
      const greeting = client
        ? await generateGreeting('returning', client.name)
        : await generateGreeting('new');
      if (greeting) {
        return greeting + ' ¿En qué puedo orientarle hoy?';
      }
    }
    const welcomeText = client ? MSG.WELCOME_BACK(client.name) : MSG.WELCOME_NEW_SHORT;
    return welcomeText + ' Cuénteme, ¿qué necesita?';
  }

  // Menu shown, waiting for selection
  if (step === 'show') {
    // Try numeric selection first (menu now goes 0-7)
    const choice = isMenuChoice(text, 8);
    if (choice !== null) {
      return await handleMenuChoice(session, choice);
    }

    // Try LLM intent detection first, fall back to regex
    let intent = null;
    if (config.gemini.enabled) {
      const { detectIntentLLM } = require('../llm/generate');
      intent = await detectIntentLLM(text);
      if (intent) console.log(`[Router] LLM intent: "${intent}" for: "${text.substring(0, 50)}"`);
    }
    if (!intent) {
      intent = detectIntent(text);
      console.log(`[Router] Regex intent: "${intent}" for: "${text.substring(0, 50)}"`);
    }
    switch (intent) {
      case 'register':
        // Only start registration for explicit "registrarme" requests
        return await handleMenuChoice(session, 1);
      case 'intake':
      case 'legal_info':
      case 'services':
      case 'appointment':
      case 'document':
        // All conversational intents → natural LLM conversation (no forced registration)
        return await handleSmartFallback(session, text, savedMedia);
      case 'case_status':
        return await handleMenuChoice(session, 4);
      case 'talk_to_lawyer':
        return await handleMenuChoice(session, 7);
      case 'goodbye':
        return await handleGlobalCommand('goodbye', session);
      case 'help':
        return MSG.HELP;
      case 'greeting':
        // Already at menu — brief natural acknowledgment, no numbered list
        return '¡Buenas! 🦉 Estoy aquí para lo que necesite. ¿En qué puedo orientarle?';
      case 'casual':
      case 'unknown':
      case 'confirm_yes':
      case 'confirm_no':
      case 'skip':
      default:
        // Natural conversational response for anything
        return await handleSmartFallback(session, text, savedMedia);
    }
  }

  // Fallback — never show the numbered menu; keep it conversational
  await transitionTo(session, 'main_menu', 'show');
  return "Disculpe, no entendí bien. ¿Podría explicarme de otra forma? Estoy aquí para ayudarle con cualquier asunto legal.";
}

async function handleMenuChoice(session, choice) {
  switch (choice) {
    case 0:
      return await handleGlobalCommand('goodbye', session);

    case 1: {
      const client = await Client.findByPhone(session.phone);
      if (client) {
        await transitionTo(session, 'intake', 'ask_case_type', { name: client.name, email: client.email, address: client.address });
        const txt = `${client.name}, ya está registrado/a en nuestro sistema.\n\nProcedamos con su nueva consulta.\n\n` + MSG.INTAKE_ASK_CASE_TYPE;
        return withList(txt, { ...LIST.CASE_TYPE, text: `${client.name}, ya está registrado/a en nuestro sistema.\n\nProcedamos con su nueva consulta.\n\n¿Qué tipo de asunto legal necesita atender?` });
      }
      await transitionTo(session, 'intake', 'ask_name');
      return MSG.INTAKE_ASK_NAME;
    }

    case 2: {
      if (!session.client_id) {
        await transitionTo(session, 'intake', 'ask_name', { returnTo: 'appointment' });
        return 'Para agendar una cita, primero necesitamos sus datos.\n\n' + MSG.INTAKE_ASK_NAME;
      }
      await transitionTo(session, 'appointment', 'ask_type');
      return withList(MSG.APPOINTMENT_INTRO, LIST.APPOINTMENT_TYPE);
    }

    case 3: {
      if (!session.client_id) {
        await transitionTo(session, 'intake', 'ask_name', { returnTo: 'document' });
        return 'Para enviar documentos, primero necesitamos registrar sus datos.\n\n' + MSG.INTAKE_ASK_NAME;
      }
      await transitionTo(session, 'document', 'ask_type');
      return withList(MSG.DOCUMENT_INTRO, LIST.DOCUMENT_TYPE);
    }

    case 4:
      await transitionTo(session, 'case_status', 'ask_or_list');
      return await caseStatusFlow.handle({ ...session, step: 'ask_or_list', data: {} }, '');

    case 5: {
      const { buildTopicMenu } = require('./flows/legalInfo');
      await transitionTo(session, 'legal_info', 'menu');
      return buildTopicMenu();
    }

    case 6: {
      const { formatAllCategories } = require('../knowledge/services');
      await transitionTo(session, 'services', 'menu');
      return formatAllCategories();
    }

    case 7:
      await transitionTo(session, 'talk_to_lawyer', 'waiting');
      return MSG.TALK_TO_LAWYER;

    case 8:
      await transitionTo(session, 'billing', 'ask_services', {
        name: session.data?.name || null,
        clientId: session.client_id || null,
      });
      return `📋 *Generación de Factura*\n\n` +
        `Ingrese los servicios a facturar.\n\n` +
        `Formato por línea:\n` +
        `*Descripción, cantidad, precio*\n\n` +
        `Ejemplo:\n` +
        `*Consulta legal, 1, 5000*\n` +
        `*Elaboración de contrato, 2, 8500*\n\n` +
        `_Escriba *cancelar* para salir._`;

    default:
      return "Disculpe, no entendí bien esa opción. ¿Podría decirme con sus palabras qué necesita?";
  }
}

async function handleSmartFallback(session, text, savedMedia = null) {
  // Check if user is requesting a quote
  if (text) {
    const { isQuoteRequest, generateQuote } = require('../llm/quoteGenerator');
    if (isQuoteRequest(text)) {
      const quoteResult = generateQuote(text);
      if (quoteResult.success) {
        console.log(`[Router] Quote request detected: ${quoteResult.items.length} items, total RD$ ${quoteResult.total}`);
        // Store quote in session for follow-up (confirmation and invoice generation)
        await transitionTo(session, 'billing', 'quote_confirm', {
          quote: quoteResult,
          quoteItems: quoteResult.items,
          quoteTotal: quoteResult.total,
          source: 'auto_quote',
        });
        return quoteResult.message;
      }
    }
  }

  // Check if user is requesting a document generation
  if (text) {
    const templateKey = detectTemplateFromText(text);
    if (templateKey) {
      const { TEMPLATES } = require('../documents/templateFields');
      const template = TEMPLATES[templateKey];
      console.log(`[Router] Document generation detected: ${templateKey}`);
      await transitionTo(session, 'doc_generation', 'confirm_template', { docGenTemplate: templateKey, docGenCollected: {} });
      return await docGenFlow.handle(
        { ...session, flow: 'doc_generation', step: 'confirm_template', data: { docGenTemplate: templateKey, docGenCollected: {} } },
        text, null, savedMedia
      );
    }
  }

  // Search knowledge base for context
  const results = searchKnowledge(text || '');
  const kbContext = results.length > 0 ? formatSearchResults(results, 1) : '';

  // Include media analysis as additional context for the LLM
  // Pre-classify the document type so the LLM doesn't guess wrong
  let mediaContext = '';
  if (savedMedia?.analysis) {
    const analysis = savedMedia.analysis;

    // Extract TIPO from structured classifier output
    const tipoMatch = analysis.match(/TIPO:\s*([A-Z_ÁÉÍÓÚ]+)/i);
    const tipo = tipoMatch ? tipoMatch[1].toUpperCase().trim() : 'DOCUMENTO';

    // Map tipo to a human-readable label and scenario hint
    const tipoLabels = {
      'CÉDULA':            'Cédula de identidad del cliente',
      'PASAPORTE':         'Pasaporte del cliente',
      'CONTRATO':          'Contrato (para notarización o revisión)',
      'NOTIFICACIÓN':      'Notificación legal / citación oficial',
      'ACTA':              'Acta',
      'PODER_NOTARIAL':    'Poder notarial',
      'CERTIFICADO_TÍTULO':'Certificado de título',
      'RECIBO':            'Recibo de pago',
      'FACTURA':           'Factura',
      'CARTA':             'Carta / comunicación',
      'FOTO_INMUEBLE':     'Foto de inmueble (para acto de venta o alquiler)',
      'FOTO_VEHÍCULO':     'Foto de vehículo (para acto de venta)',
      'OTRO':              'Documento no clasificado',
    };
    const tipoLabel = tipoLabels[tipo] || `Documento (${tipo})`;

    // Scenario hint injected for the LLM
    const scenarioHints = {
      'CÉDULA':       'Aplica Escenario 9: confirmar recibo de datos, preguntar para qué trámite los necesita. NO asumir contexto.',
      'PASAPORTE':    'Aplica Escenario 9: confirmar recibo de datos, preguntar para qué trámite los necesita.',
      'NOTIFICACIÓN': 'Aplica Escenario 10: confirmar recibo del documento, responder que un digitador le estará asistiendo en breve.',
      'CONTRATO':     'Aplica Escenario 5: verifica primero si el cliente quiere MODIFICAR este contrato existente o necesita uno NUEVO. Si el contexto de la conversación habla de "cambiar", "modificar", "corregir" o "hacerlo de nuevo" — es una MODIFICACIÓN. Cotiza la modificación como documento nuevo (misma tarifa). Si no hay contexto de modificación, pregunta si desea notarización o revisión.',
      'FOTO_INMUEBLE':'Aplica Escenario 3: identificar valor del bien, cotizar acto de venta según Ley 140-15.',
      'FOTO_VEHÍCULO':'Aplica Escenario 3: identificar valor del vehículo, cotizar acto de venta según Ley 140-15.',
    };
    const hint = scenarioHints[tipo] || '';

    mediaContext = `\n\n[CLASIFICACIÓN DEL ARCHIVO ENVIADO]
TIPO DETECTADO: ${tipoLabel}
DATOS: ${analysis}
${hint ? `INSTRUCCIÓN: ${hint}` : ''}
[FIN CLASIFICACIÓN]`;
  }

  // Try LLM with knowledge base context (RAG-lite) + conversation history
  if (config.gemini.enabled) {
    const Message = require('../models/Message');
    const { generateLegalResponse } = require('../llm/generate');

    // Fetch recent conversation for context-aware responses
    let history = [];
    try {
      history = await Message.findRecentByPhone(session.phone, 20);
    } catch (err) {
      console.error('[Router] Error fetching conversation history:', err.message);
    }

    // Build client/case context so the bot remembers who it's talking to
    let clientContext = '';
    try {
      const client = await Client.findByPhone(session.phone);
      if (client) {
        const activeCases = await Case.findAll({ clientId: client.id, status: 'active' });
        const parts = [];
        parts.push(`Nombre del cliente: ${client.name || 'No registrado'}`);
        if (client.email) parts.push(`Correo: ${client.email}`);
        if (client.address) parts.push(`Dirección: ${client.address}`);
        if (activeCases.length > 0) {
          const caseSummary = activeCases.map(c =>
            `- Expediente ${c.case_number || c.id}: ${c.title || 'Sin título'} (${c.case_type || 'tipo no especificado'})`
          ).join('\n');
          parts.push(`Casos activos del cliente:\n${caseSummary}`);
        }
        clientContext = '\n\n[DATOS DEL CLIENTE]\n' + parts.join('\n') + '\n[FIN DATOS DEL CLIENTE]';
      }
    } catch (err) {
      console.error('[Router] Error building client context:', err.message);
    }

    const query = text || (savedMedia?.analysis ? 'El cliente envió un archivo.' : '');
    const llmResponse = await generateLegalResponse(query, kbContext + mediaContext + clientContext, history);
    if (llmResponse) {
      console.log(`[LLM] Smart fallback responded to: "${(text || '[media]').substring(0, 50)}"`);
      return llmResponse;
    }
  }

  // Fallback: show keyword results directly
  if (kbContext) {
    return kbContext;
  }

  return "Disculpe, no entendí bien. ¿Podría explicarme de otra forma? Estoy aquí para ayudarle con cualquier asunto legal.";
}

async function handleTalkToLawyer(session, text) {
  const intent = detectIntent(text);
  if (intent === 'urgent') {
    await transitionTo(session, 'main_menu', 'show', {});
    return withList(MSG.TALK_TO_LAWYER_URGENT + '\n\n' + MSG.MAIN_MENU, LIST.MAIN_MENU);
  }

  // Any other message — log it and go back to menu
  await transitionTo(session, 'main_menu', 'show', {});
  return withList('Su mensaje ha sido enviado a nuestro equipo legal. Le contactaremos a la brevedad.\n\n' + MSG.MAIN_MENU, LIST.MAIN_MENU);
}

module.exports = { routeMessage };
