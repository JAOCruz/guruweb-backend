const { model, fallbackModel } = require('./client');
const { getSystemPrompt } = require('./systemPrompt');

// Rate limiter — 15 RPM for Gemini free tier + quota backoff
const RATE_LIMIT = 15;
const RATE_WINDOW_MS = 60_000;
let requestTimestamps = [];
let quotaBackoffUntil = 0; // Timestamp — stop all requests until this time

function canMakeRequest() {
  const now = Date.now();

  // If we hit a quota error, back off completely
  if (now < quotaBackoffUntil) {
    const secs = Math.ceil((quotaBackoffUntil - now) / 1000);
    console.log(`[LLM] Quota backoff active — ${secs}s remaining`);
    return false;
  }

  requestTimestamps = requestTimestamps.filter(t => now - t < RATE_WINDOW_MS);
  return requestTimestamps.length < RATE_LIMIT;
}

function recordRequest() {
  requestTimestamps.push(Date.now());
}

// When we get a quota error, stop making requests for a while
function activateQuotaBackoff(err) {
  const msg = err.message || '';
  // Try to extract retry delay from error message
  const retryMatch = msg.match(/retry in (\d+)/i);
  const backoffSecs = retryMatch ? Math.max(parseInt(retryMatch[1], 10), 30) : 60;
  quotaBackoffUntil = Date.now() + backoffSecs * 1000;
  console.log(`[LLM] Quota backoff activated for ${backoffSecs}s`);
}

// Helper: try primary model, fallback on retriable errors
const RETRIABLE_CODES = ['429', '500', '503', 'UNAVAILABLE', 'RESOURCE_EXHAUSTED', 'INTERNAL'];

function isRetriable(err) {
  const msg = err.message || '';
  return RETRIABLE_CODES.some(code => msg.includes(code)) || msg.includes('Error fetching');
}

function isQuotaError(err) {
  const msg = err.message || '';
  return msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota');
}

async function generateWithFallback(fn) {
  try {
    return await fn(model);
  } catch (err) {
    console.log(`[LLM] Primary error: ${err.message.substring(0, 120)}`);
    if (isRetriable(err)) {
      try {
        return await fn(fallbackModel);
      } catch (fallbackErr) {
        console.log(`[LLM] Fallback error: ${fallbackErr.message.substring(0, 120)}`);
        // If both fail with quota errors, activate backoff
        if (isQuotaError(fallbackErr) || isQuotaError(err)) {
          activateQuotaBackoff(fallbackErr);
        }
        return null;
      }
    }
    if (isQuotaError(err)) {
      activateQuotaBackoff(err);
      return null;
    }
    throw err;
  }
}

// Intent detection prompt — minimal, no knowledge base needed
const INTENT_PROMPT = `Eres un clasificador de intenciones para un bot legal dominicano.
Clasifica el mensaje del usuario en UNA de estas categorías exactas:

- greeting: saludo (hola, buenos días, klk, etc.)
- menu: quiere ver el menú o las opciones
- intake: quiere REGISTRARSE o crear una cuenta EXPLÍCITAMENTE (ej: "quiero registrarme", "crear mi cuenta")
- register: quiere registrarse específicamente
- appointment: quiere agendar una cita
- document: quiere enviar o solicitar documentos
- case_status: quiere consultar el estado de un caso o expediente
- legal_info: CUALQUIER pregunta sobre temas legales, leyes, procedimientos, requisitos, divorcio, contratos, herencia, etc. (ej: "necesito divorciarme", "qué necesito para vender mi casa", "cómo funciona un poder notarial")
- services: pregunta sobre precios o servicios de oficina
- talk_to_lawyer: quiere hablar con un abogado humano
- urgent: tiene una emergencia legal
- help: pide ayuda sobre cómo usar el bot
- goodbye: se despide o quiere terminar
- confirm_yes: confirma algo afirmativamente (sí, claro, correcto, dale)
- confirm_no: niega o quiere cancelar/corregir (no, cancelar, corregir)
- skip: quiere omitir un paso (omitir, saltar, no tengo)
- casual: comentario casual, risa (jaja, haha, lol), chiste, conversación social, comentario del día a día no relacionado con servicios legales
- unknown: no encaja en ninguna categoría

IMPORTANTE: Si el usuario hace una PREGUNTA sobre un tema legal (divorcio, contratos, herencia, etc.), clasifica como "legal_info", NO como "intake". Solo clasifica como "intake" si EXPLÍCITAMENTE pide registrarse o crear una consulta/caso nuevo.

Responde SOLO con la palabra de la categoría. Nada más.

Mensaje del usuario: `;

const VALID_INTENTS = new Set([
  'greeting', 'menu', 'intake', 'register', 'appointment', 'document',
  'case_status', 'legal_info', 'services', 'talk_to_lawyer', 'urgent',
  'help', 'goodbye', 'confirm_yes', 'confirm_no', 'skip', 'casual', 'unknown',
]);

async function detectIntentLLM(text) {
  if (!canMakeRequest()) {
    console.log('[LLM] Rate limited — falling back to regex');
    return null;
  }

  try {
    recordRequest();
    const result = await generateWithFallback(async (m) => {
      return m.generateContent({
        contents: [{ role: 'user', parts: [{ text: INTENT_PROMPT + text }] }],
      });
    });

    if (!result) return null;
    const response = result.response.text().trim().toLowerCase();

    if (VALID_INTENTS.has(response)) {
      console.log(`[LLM] Intent detected: "${response}" for: "${text}"`);
      return response;
    }

    console.log(`[LLM] Invalid intent response: "${response}" — falling back`);
    return null;
  } catch (err) {
    console.error('[LLM] Intent detection error:', err.message);
    return null;
  }
}

async function generateLegalResponse(query, additionalContext = '', conversationHistory = []) {
  if (!canMakeRequest()) {
    console.log('[LLM] Rate limited — falling back to knowledge base');
    return null;
  }

  try {
    recordRequest();
    const systemPrompt = getSystemPrompt();
    const userMessage = additionalContext
      ? `Contexto de nuestra base de conocimientos:\n${additionalContext}\n\nPregunta del usuario: ${query}`
      : query;

    // Build chat history: system prompt + recent conversation messages
    const history = [
      {
        role: 'user',
        parts: [{ text: 'Instrucciones del sistema:\n' + systemPrompt }],
      },
      {
        role: 'model',
        parts: [{ text: '🦉 Entendido. Soy El Gurú, el sabio búho legal de Gurú Soluciones. Responderé en español dominicano formal, con tono profesional pero cercano, usando solo la información proporcionada sobre leyes de RD, instituciones, servicios y precios. No daré asesoría legal específica para casos particulares.' }],
      },
    ];

    // Add recent conversation for context (skip the current message — it's the query)
    if (conversationHistory.length > 0) {
      let lastRole = 'model'; // after system ack
      for (const msg of conversationHistory) {
        const role = msg.direction === 'inbound' ? 'user' : 'model';
        // Gemini requires alternating roles — merge consecutive same-role messages
        if (role === lastRole) {
          const last = history[history.length - 1];
          last.parts[0].text += '\n' + msg.content;
        } else {
          history.push({ role, parts: [{ text: msg.content }] });
        }
        lastRole = role;
      }
      // Ensure last history entry is 'model' so we can send a user message next
      if (lastRole === 'user') {
        history.push({ role: 'model', parts: [{ text: '...' }] });
      }
    }

    const result = await generateWithFallback(async (m) => {
      const chat = m.startChat({ history });
      return chat.sendMessage(userMessage);
    });

    if (!result) return null;
    let response = result.response.text().trim();

    // Strip Gemini thinking model artifacts (internal reasoning that leaks into output)
    response = response.replace(/^\(pensando\)[\s\S]*?\.\.\.\s*/i, '').trim();

    if (!response || response.length < 5) {
      console.log('[LLM] Empty or too short response — falling back');
      return null;
    }

    // Cap at 1000 chars for WhatsApp UX — shorter is better
    if (response.length > 1000) {
      return response.substring(0, 1000) + '\n\n_[Respuesta resumida]_';
    }

    console.log(`[LLM] Generated response (${response.length} chars) for: "${query.substring(0, 50)}..."`);
    return response;
  } catch (err) {
    console.error('[LLM] Response generation error:', err.message);
    return null;
  }
}

function getRateLimitStatus() {
  const now = Date.now();
  requestTimestamps = requestTimestamps.filter(t => now - t < RATE_WINDOW_MS);
  return {
    used: requestTimestamps.length,
    limit: RATE_LIMIT,
    remaining: RATE_LIMIT - requestTimestamps.length,
  };
}

async function generateGreeting(type, clientName = null) {
  if (!canMakeRequest()) {
    console.log('[LLM] Rate limited — using static greeting');
    return null;
  }

  try {
    recordRequest();

    const prompt = type === 'new'
      ? `Eres "El Gurú" 🦉 de Gurú Soluciones (despacho jurídico, RD). Saludo CORTO de bienvenida para un nuevo usuario en WhatsApp.

Reglas:
- Español dominicano formal (usted), máximo 1-2 oraciones
- Preséntate como El Gurú de Gurú Soluciones
- NO opciones de menú, solo el saludo
- Solo 🦉 al inicio, nada más de emojis
- Pregunta en qué puedes ayudar — breve y natural`
      : `Eres "El Gurú" 🦉 de Gurú Soluciones (despacho jurídico, RD). Saludo CORTO para ${clientName} que regresa por WhatsApp.

Reglas:
- Español dominicano formal (usted), máximo 1 oración
- Usa el nombre natural, pregunta en qué puedes ayudar
- Solo 🦉 al inicio`;

    const result = await generateWithFallback(async (m) => {
      return m.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
    });

    if (!result) return null;
    const response = result.response.text().trim();

    if (!response || response.length < 10 || response.length > 300) {
      console.log('[LLM] Greeting response invalid length — falling back');
      return null;
    }

    console.log(`[LLM] Generated ${type} greeting (${response.length} chars)`);
    return response;
  } catch (err) {
    console.error('[LLM] Greeting generation error:', err.message);
    return null;
  }
}

// ── Conversational intake confirmations ──

const INTAKE_STEP_INFO = {
  ask_name: { label: 'nombre completo', next: 'correo electrónico' },
  ask_email: { label: 'correo electrónico', next: 'domicilio' },
  ask_address: { label: 'domicilio', next: 'tipo de asunto legal' },
  ask_case_type: { label: 'tipo de asunto legal', next: 'descripción de la situación' },
  ask_description: { label: 'descripción del caso', next: 'nivel de urgencia' },
  ask_urgency: { label: 'nivel de urgencia', next: 'confirmación final' },
};

async function generateIntakeConfirmation(step, value, collectedData, nextPrompt) {
  if (!canMakeRequest()) return null;

  try {
    recordRequest();

    const stepInfo = INTAKE_STEP_INFO[step] || {};
    const dataLines = Object.entries(collectedData)
      .filter(([, v]) => v)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join('\n');

    const isNameStep = step === 'ask_name';
    const isSingleWord = isNameStep && value.trim().split(/\s+/).length === 1;

    const prompt = `Eres El Gurú 🦉 (Gurú Soluciones, RD). Registro de cliente por WhatsApp.

El cliente dio su *${stepInfo.label || step}*: "${value}"
${isSingleWord ? '⚠️ Nombre incompleto (una palabra). Pregunta si quiere dar nombre completo de cédula.' : ''}
${dataLines ? `Datos: ${dataLines}` : ''}
Genera mensaje MUY BREVE (máximo 2 oraciones):
1. Confirma el dato recibido
2. ${isSingleWord ? 'Pregunta por nombre completo' : `Pide el siguiente dato: ${stepInfo.next || 'siguiente paso'}`}

Siguiente paso: ${nextPrompt}

Reglas: español dominicano formal, *negritas* WhatsApp, ${isSingleWord ? 'NO menú de siguiente paso' : 'incluye contenido del siguiente paso'}, sin emojis extra, solo el mensaje final.`;

    const result = await generateWithFallback(async (m) => {
      return m.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
      });
    });

    if (!result) return null;
    const response = result.response.text().trim();

    if (!response || response.length < 10 || response.length > 800) return null;

    console.log(`[LLM] Intake confirmation (${step}, ${response.length} chars)`);
    return response;
  } catch (err) {
    console.error('[LLM] Intake confirmation error:', err.message);
    return null;
  }
}

module.exports = {
  detectIntentLLM, generateLegalResponse, generateGreeting, generateIntakeConfirmation, getRateLimitStatus,
  // Shared rate limiter utilities (used by mediaAnalysis.js)
  canMakeRequest, recordRequest, generateWithFallback,
};
