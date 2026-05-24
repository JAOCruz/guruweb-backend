const Client = require('../../models/Client');
const Case = require('../../models/Case');
const Message = require('../../models/Message');
const { transitionTo, updateData } = require('../stateManager');
const { MSG, LIST, CASE_TYPES, URGENCY_LEVELS } = require('../messages');
const { withList } = require('../../whatsapp/interactive');
const { isValidEmail, detectIntent, normalize, isEscapeIntent, extractCedula } = require('../nlp');
const config = require('../../config');

let caseCounter = 0;

function generateCaseNumber() {
  caseCounter++;
  const ts = Date.now().toString(36).toUpperCase();
  return `CASO-${ts}-${String(caseCounter).padStart(3, '0')}`;
}

// Try LLM confirmation, return null if unavailable
async function tryConfirmation(step, value, collectedData, nextPrompt) {
  if (!config.gemini.enabled) return null;
  try {
    const { generateIntakeConfirmation } = require('../../llm/generate');
    return await generateIntakeConfirmation(step, value, collectedData, nextPrompt);
  } catch (err) {
    console.error('[Intake] LLM confirmation error:', err.message);
    return null;
  }
}

// Steps where escape detection applies (data collection, not routing)
const ESCAPABLE_STEPS = new Set([
  'ask_name', 'confirm_name', 'ask_email', 'ask_address',
  'ask_case_type', 'ask_description', 'ask_urgency',
]);

async function handle(session, text, msg) {
  const step = session.step;

  // Detect escape intent during data collection steps
  if (ESCAPABLE_STEPS.has(step) && isEscapeIntent(text)) {
    await transitionTo(session, 'main_menu', 'show');
    return withList('🦉 Entendido, hemos cancelado el proceso de registro. ¿En qué más puedo ayudarle?\n\n' + MSG.MAIN_MENU, LIST.MAIN_MENU);
  }

  switch (step) {
    // Welcome screen for new users — they picked option 1 (register) or 2 (quick question)
    case 'welcome_choice': {
      const choice = text.trim();
      if (choice === '1') {
        await transitionTo(session, 'intake', 'ask_name');
        return MSG.INTAKE_ASK_NAME;
      }
      if (choice === '2') {
        await transitionTo(session, 'intake', 'quick_question');
        return MSG.INTAKE_QUICK_QUESTION;
      }

      // Not "1" or "2" — try LLM intent detection, then regex
      let intent = null;
      if (config.gemini.enabled) {
        try {
          const { detectIntentLLM } = require('../../llm/generate');
          intent = await detectIntentLLM(text);
        } catch (err) {
          console.error('[Intake] LLM intent error:', err.message);
        }
      }
      if (!intent) {
        intent = detectIntent(text);
      }

      // Route based on detected intent
      if (intent === 'register' || intent === 'intake' || intent === 'confirm_yes') {
        await transitionTo(session, 'intake', 'ask_name');
        return MSG.INTAKE_ASK_NAME;
      }
      if (intent === 'legal_info' || intent === 'services' || intent === 'appointment' || intent === 'case_status') {
        // They want something specific — jump to menu so router handles it
        await transitionTo(session, 'main_menu', 'show');
        const { routeMessage } = require('../router');
        return await routeMessage(session.phone, text, msg);
      }
      if (intent === 'greeting') {
        return `🦉 ¡Hola! ¿En qué podemos ayudarle?\n\n` +
          `1️⃣ Registrarme para atención personalizada\n` +
          `2️⃣ Solo tengo una consulta rápida`;
      }
      if (intent === 'goodbye') {
        const ConversationSession = require('../../models/ConversationSession');
        await ConversationSession.close(session.id);
        return MSG.GOODBYE;
      }

      // If text is long enough, try LLM smart fallback for legal questions
      if (config.gemini.enabled && text.length > 10) {
        try {
          const { generateLegalResponse } = require('../../llm/generate');
          const llmResponse = await generateLegalResponse(text);
          if (llmResponse) {
            await transitionTo(session, 'main_menu', 'show');
            return llmResponse + '\n\n_Si desea registrarse, escriba *"registrarme"*. Para ver opciones, escriba *"menu"*._';
          }
        } catch (err) {
          console.error('[Intake] LLM fallback error:', err.message);
        }
      }

      return `Disculpe, no comprendí su selección. Por favor, elija:\n\n` +
        `1️⃣ Registrarme para atención personalizada\n` +
        `2️⃣ Solo tengo una consulta rápida`;
    }

    case 'quick_question': {
      // Log the quick question
      await Message.create({
        clientId: null,
        phone: session.phone,
        direction: 'inbound',
        content: `[Consulta rápida] ${text}`,
      });

      const intent = detectIntent(text);
      if (intent === 'register') {
        await transitionTo(session, 'intake', 'ask_name');
        return MSG.INTAKE_ASK_NAME;
      }

      // Try LLM response for their question
      if (config.gemini.enabled) {
        try {
          const { generateLegalResponse } = require('../../llm/generate');
          const llmResponse = await generateLegalResponse(text);
          if (llmResponse) {
            // Go to menu:show so next message gets full LLM treatment
            await transitionTo(session, 'main_menu', 'show');
            return llmResponse + '\n\n_Si desea registrarse para seguimiento personalizado, escriba *"registrarme"*. Para ver opciones, escriba *"menu"*._';
          }
        } catch (err) {
          console.error('[Intake] LLM quick question error:', err.message);
        }
      }

      // Fallback — go to menu:show (NOT init) so next message doesn't restart welcome
      await transitionTo(session, 'main_menu', 'show');
      return MSG.INTAKE_QUICK_RECEIVED + '\n\n' + MSG.MAIN_MENU;
    }

    case 'ask_name': {
      // Detect if user included a cédula number with their name
      const cedulaInfo = extractCedula(text);
      let name = text.trim();
      if (cedulaInfo) {
        name = name.replace(cedulaInfo.raw, '').replace(/\s+/g, ' ').trim();
        await updateData(session, { cedula: cedulaInfo.cedula });
      }

      if (name.length < 2) {
        return 'Por favor, ingrese su nombre completo.';
      }

      // Detect if user typed a question, legal term, or service request instead of their name
      const looksLikeQuestion = /[?¿]/.test(name)
        || /^(que|por ?que|para que|como|cuando|donde|cual|quien|necesito|quiero|ayuda)/i.test(normalize(name))
        // Legal terms / document types
        || /\b(acto|contrato|divorcio|demanda|herencia|poder|notaria|cedula|caso|consulta|cobro|deuda|alquiler|arrendamiento|sociedad|empresa|registro|titulo|propiedad|deslinde|particion|sucesion|testamento|pension|laboral|despido|accidente|prestamo|hipoteca|embargo|desahucio|amparo|recurso|ley|codigo|decreto|resolucion|sentencia|apelacion|venta|compra|tierra|solar|apartamento|casa|inmueble)\b/i.test(normalize(name))
        // Service request patterns
        || /\b(por favor|necesito|quiero|me puede|puede ayudarme|ayuda con|informacion sobre|info sobre|precio de|cuanto cuesta|como hago|que necesito|tramite|servicio|ayudarme)\b/i.test(normalize(name))
        // Looks like a sentence not a name (4+ words or very long)
        || (name.split(/\s+/).length >= 4 && name.length > 20);

      if (looksLikeQuestion) {
        // They're asking something or giving a legal topic — answer via LLM
        if (config.gemini.enabled) {
          try {
            const { generateLegalResponse } = require('../../llm/generate');
            const llmResponse = await generateLegalResponse(text);
            if (llmResponse) {
              await transitionTo(session, 'main_menu', 'show');
              return llmResponse;
            }
          } catch (err) {
            console.error('[Intake] Name-step LLM error:', err.message);
          }
        }
        await transitionTo(session, 'main_menu', 'show');
        return 'Parece que tiene una consulta. Le regresamos al menú principal para asistirle mejor.\n\n' + MSG.MAIN_MENU;
      }

      // Reject strings that clearly aren't names (too many numbers, special chars, etc.)
      const nameChars = name.replace(/[^a-záéíóúñü\s]/gi, '');
      if (nameChars.length < name.length * 0.7) {
        return 'Eso no parece ser un nombre. Por favor, indíquenos su *nombre completo* o escriba *"menu"* para regresar.';
      }

      const isSingleWord = name.split(/\s+/).length === 1;

      // If single word name, ask for confirmation before proceeding
      if (isSingleWord && !session.data?.nameConfirmed) {
        await updateData(session, { name, nameConfirmed: false });
        // Stay on ask_name but mark that we've asked
        await transitionTo(session, 'intake', 'confirm_name', { ...session.data, name, nameConfirmed: false });

        const llm = await tryConfirmation('ask_name', name, {}, MSG.INTAKE_ASK_EMAIL);
        return llm || `Gracias, *${name}*. Para que su información quede correcta en nuestro sistema, ¿podría proporcionarnos su nombre completo como aparece en su cédula?\n\nSi *${name}* es su nombre completo, simplemente escriba *"sí"* para continuar.`;
      }

      await updateData(session, { name });
      await transitionTo(session, 'intake', 'ask_email', { ...session.data, name });

      const llm = await tryConfirmation('ask_name', name, { nombre: name }, MSG.INTAKE_ASK_EMAIL);
      return llm || `Perfecto, *${name}*. ${MSG.INTAKE_ASK_EMAIL}`;
    }

    case 'confirm_name': {
      const norm = normalize(text);
      const prevName = session.data?.name || '';

      // User confirmed single-word name
      if (norm === 'si' || norm === 'confirmar' || norm === 'correcto' || text.trim() === '1') {
        await updateData(session, { nameConfirmed: true });
        await transitionTo(session, 'intake', 'ask_email', { ...session.data, nameConfirmed: true });

        const llm = await tryConfirmation('ask_name', prevName, { nombre: prevName }, MSG.INTAKE_ASK_EMAIL);
        return llm || `Entendido, *${prevName}*. ${MSG.INTAKE_ASK_EMAIL}`;
      }

      // User provided their full name
      const fullName = text.trim();
      if (fullName.length >= 2) {
        await updateData(session, { name: fullName, nameConfirmed: true });
        await transitionTo(session, 'intake', 'ask_email', { ...session.data, name: fullName, nameConfirmed: true });

        const llm = await tryConfirmation('ask_name', fullName, { nombre: fullName }, MSG.INTAKE_ASK_EMAIL);
        return llm || `Perfecto, *${fullName}*. ${MSG.INTAKE_ASK_EMAIL}`;
      }

      return 'Por favor, escriba su nombre completo o escriba *"sí"* para continuar.';
    }

    case 'ask_email': {
      const norm = normalize(text);

      // If user typed a question instead of an email, help them out
      const looksLikeQuestion = /[?¿]/.test(text) || /^(que|por ?que|para que|como|necesito|quiero|ayuda|no entiendo)/i.test(norm);
      if (looksLikeQuestion && text.trim().length > 5) {
        if (config.gemini.enabled) {
          try {
            const { generateLegalResponse } = require('../../llm/generate');
            const llmResponse = await generateLegalResponse(text);
            if (llmResponse) {
              await transitionTo(session, 'main_menu', 'show');
              return llmResponse;
            }
          } catch (err) {
            console.error('[Intake] Email-step LLM error:', err.message);
          }
        }
        await transitionTo(session, 'main_menu', 'show');
        return 'Parece que tiene una consulta. Le regresamos al menú principal.\n\n' + MSG.MAIN_MENU;
      }

      // Input has no @ and is substantial → clearly not an email attempt
      if (!text.includes('@') && text.trim().length > 10 && norm !== 'omitir' && norm !== 'no tengo' && norm !== 'saltar') {
        let intent = null;
        if (config.gemini.enabled) {
          try {
            const { detectIntentLLM } = require('../../llm/generate');
            intent = await detectIntentLLM(text);
          } catch (err) {
            console.error('[Intake] Email-step intent error:', err.message);
          }
        }
        if (!intent) intent = detectIntent(text);

        if (['legal_info', 'services', 'appointment', 'case_status', 'document', 'intake', 'register'].includes(intent)) {
          await transitionTo(session, 'main_menu', 'show');
          const { routeMessage } = require('../router');
          return await routeMessage(session.phone, text, msg);
        }
        if (intent === 'unknown' && text.trim().length > 20) {
          await transitionTo(session, 'main_menu', 'show');
          const { routeMessage } = require('../router');
          return await routeMessage(session.phone, text, msg);
        }
      }

      let email = null;
      if (norm !== 'omitir' && norm !== 'no' && norm !== 'no tengo' && norm !== 'saltar') {
        if (!isValidEmail(text)) {
          return 'El formato del correo electrónico no es válido. Por favor, ingréselo nuevamente o escriba *"omitir"*.';
        }
        email = text.trim();
      }
      await updateData(session, { email });
      await transitionTo(session, 'intake', 'ask_address', { ...session.data, email });

      const collected = { nombre: session.data.name };
      if (email) collected.correo = email;

      const llm = await tryConfirmation('ask_email', email || 'omitido', collected, MSG.INTAKE_ASK_ADDRESS);
      if (llm) return llm;

      const confirmation = email ? `Correo registrado: *${email}*. ` : 'Sin problema, continuamos sin correo. ';
      return confirmation + MSG.INTAKE_ASK_ADDRESS;
    }

    case 'ask_address': {
      const norm = normalize(text);
      const address = (norm === 'omitir' || norm === 'no' || norm === 'no tengo' || norm === 'saltar') ? null : text.trim();
      await updateData(session, { address });
      await transitionTo(session, 'intake', 'ask_case_type', { ...session.data, address });

      const collected = { nombre: session.data.name };
      if (session.data.email) collected.correo = session.data.email;
      if (address) collected.domicilio = address;

      const llm = await tryConfirmation('ask_address', address || 'omitido', collected, MSG.INTAKE_ASK_CASE_TYPE);
      if (llm) return withList(llm, LIST.CASE_TYPE);

      const confirmation = address ? `Domicilio registrado. ` : 'Entendido. ';
      const fullText = confirmation + `Ahora necesitamos saber sobre su asunto legal.\n\n` + MSG.INTAKE_ASK_CASE_TYPE;
      return withList(fullText, { ...LIST.CASE_TYPE, text: confirmation + `Ahora necesitamos saber sobre su asunto legal.` });
    }

    case 'ask_case_type': {
      const choice = text.trim();
      let caseType = CASE_TYPES[choice];

      // Also accept text answers (e.g., "Civil", "Otro", "Penal")
      if (!caseType) {
        const norm = normalize(choice);
        for (const [key, value] of Object.entries(CASE_TYPES)) {
          if (normalize(value).includes(norm) || norm.includes(normalize(value).split(/[\s\/]/)[0])) {
            caseType = value;
            break;
          }
        }
      }
      if (!caseType) {
        // Input doesn't match any case type — escape to smart fallback
        // instead of getting stuck repeating "select 1-9"
        if (choice.length > 5) {
          await transitionTo(session, 'main_menu', 'show');
          const { routeMessage } = require('../router');
          return await routeMessage(session.phone, text, msg);
        }
        return 'Seleccione un número del 1 al 9 o escriba el tipo de asunto (ej: "civil", "penal", "familia").';
      }
      await updateData(session, { caseType, caseTypeCode: choice });
      await transitionTo(session, 'intake', 'ask_description', { ...session.data, caseType, caseTypeCode: choice });

      const collected = { nombre: session.data.name, 'área legal': caseType };

      const llm = await tryConfirmation('ask_case_type', caseType, collected, MSG.INTAKE_ASK_DESCRIPTION);
      return llm || `*${caseType}*, entendido. ${MSG.INTAKE_ASK_DESCRIPTION}`;
    }

    case 'ask_description': {
      const description = text.trim();
      if (description.length < 10) {
        return 'Por favor, proporcione una descripción más detallada de su situación (mínimo 10 caracteres).';
      }
      await updateData(session, { description });
      await transitionTo(session, 'intake', 'ask_urgency', { ...session.data, description });

      const collected = {
        nombre: session.data.name,
        'área legal': session.data.caseType,
        descripción: description.substring(0, 50) + (description.length > 50 ? '...' : ''),
      };

      const llm = await tryConfirmation('ask_description', description, collected, MSG.INTAKE_ASK_URGENCY);
      if (llm) return withList(llm, LIST.URGENCY);
      return withList(`Hemos registrado su situación. ${MSG.INTAKE_ASK_URGENCY}`, LIST.URGENCY);
    }

    case 'ask_urgency': {
      const choice = text.trim();
      const urgency = URGENCY_LEVELS[choice];
      if (!urgency) {
        // If it's not 1/2/3 and substantial text, escape to smart fallback
        if (choice.length > 5) {
          await transitionTo(session, 'main_menu', 'show');
          const { routeMessage } = require('../router');
          return await routeMessage(session.phone, text, msg);
        }
        return 'Seleccione: 1 (Urgente), 2 (Moderado) o 3 (Normal).';
      }
      const data = { ...session.data, urgency };
      await updateData(session, { urgency });
      await transitionTo(session, 'intake', 'confirm', data);
      return withList(MSG.INTAKE_CONFIRM(data), LIST.INTAKE_CONFIRM(data));
    }

    case 'confirm': {
      const choice = text.trim();
      if (choice === '1' || normalize(text) === 'si' || normalize(text) === 'confirmar') {
        return await completeIntake(session);
      }
      if (choice === '2' || normalize(text) === 'no' || normalize(text) === 'corregir') {
        await transitionTo(session, 'intake', 'ask_name', {});
        return 'De acuerdo, comencemos nuevamente.\n\n' + MSG.INTAKE_ASK_NAME;
      }
      return MSG.INVALID_OPTION;
    }

    case 'ask_billing': {
      const choice = text.trim();
      const norm = normalize(text);
      if (choice === '1' || norm === 'si' || norm === 'sí' || norm === 'billing' || norm === 'generar' || norm === 'si generar') {
        // Transition to billing flow, preserving intake data
        await transitionTo(session, 'billing', 'ask_services', {
          clientId: session.client_id || null,
          clientName: session.data?.name || null,
          lastCaseNumber: session.data?.caseNumber || null,
        });
        return await billingFlow.handle(session, text, msg);
      }
      // No, gracias — return to main menu
      await transitionTo(session, 'main_menu', 'show', {});
      return withList(MSG.MAIN_MENU, LIST.MAIN_MENU);
    }

    default:
      await transitionTo(session, 'intake', 'ask_name');
      return MSG.INTAKE_ASK_NAME;
  }
}

async function completeIntake(session) {
  const data = session.data;

  try {
    // Create or update client
    const defaultUserId = await Client.getDefaultUserId();
    let client = await Client.findByPhone(session.phone);
    if (!client) {
      client = await Client.create({
        name: data.name,
        phone: session.phone,
        email: data.email,
        address: data.address,
        notes: `Urgencia: ${data.urgency}${data.cedula ? ` | Cédula: ${data.cedula}` : ''}`,
        userId: defaultUserId,
      });
    }

    // Link client to session
    const ConversationSession = require('../../models/ConversationSession');
    await ConversationSession.setClientId(session.id, client.id);

    // Link any orphaned media from this phone to the new client
    const ClientMedia = require('../../models/ClientMedia');
    await ClientMedia.linkToClient(session.phone, client.id);

    // Create case
    const caseNumber = generateCaseNumber();
    await Case.create({
      caseNumber,
      title: `${data.caseType} — ${data.name}`,
      description: data.description,
      caseType: data.caseType,
      clientId: client.id,
      userId: defaultUserId,
    });

    // Store caseNumber in session so billing can reference it
    await updateData(session, { lastCaseNumber: caseNumber });

    // Ask "¿Sería eso todo?" — transition to billing if yes, menu if no
    await transitionTo(session, 'intake', 'ask_billing', { ...data, caseNumber });

    const billingPrompt =
      `✅ *Consulta registrada — ${caseNumber}*\n\n` +
      `¿Desea generar la *factura* ahora?\n\n` +
      `1️⃣ *Sí, generar factura*\n` +
      `2️⃣ *No, gracias*\n\n` +
      `_Nuestro equipo se pondrá en contacto pronto._`;

    return withList(
      MSG.INTAKE_SUCCESS(caseNumber) + '\n\n' + billingPrompt,
      { title: '¿Generar factura?', rows: [
        { id: 'billing', title: 'Sí, generar factura' },
        { id: 'menu',    title: 'No, gracias' },
      ]}
    );
  } catch (err) {
    console.error('[Intake] Error completing intake:', err);
    return MSG.ERROR_GENERAL;
  }
}

module.exports = { handle };
