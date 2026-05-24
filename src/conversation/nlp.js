// Spanish NLP — keyword and pattern-based intent detection for DR legal services

function normalize(text) {
  return text
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // strip accents
    .replace(/[^\w\s]/g, '')                             // strip punctuation
    .trim();
}

// ── Intent patterns ──
const INTENT_PATTERNS = {
  greeting: [
    /\b(hola|buenos?\s*dias?|buenas?\s*tardes?|buenas?\s*noches?|saludos?|que\s*tal|hey|klk|dime)\b/,
  ],
  menu: [
    /\b(menu|inicio|principal|regresar|volver|opciones)\b/,
  ],
  intake: [
    /\b(consulta|asesoria|nuevo\s*caso|registrar|necesito\s*ayuda|problema\s*legal|abogado)\b/,
    /\b(demanda|denuncia|quiero\s*demandar|me\s*demandaron|asunto\s*legal)\b/,
  ],
  appointment: [
    /\b(cita|agendar|agenda|programar|horario|disponibilidad|reunion|visita)\b/,
  ],
  document: [
    /\b(documento|documentos?|archivo|enviar\s*archivo|subir|adjuntar|papel|papeles)\b/,
    /\b(cedula|pasaporte|acta|contrato|poder\s*notarial|comprobante|certificado\s*de\s*titulo)\b/,
    /\b(redaccion|redactar|elaborar\s*documento)\b/,
  ],
  case_status: [
    /\b(estado|estatus|expediente|caso|seguimiento|avance|como\s*va)\b/,
    /\b(consultar\s*caso|mi\s*caso|numero\s*de\s*caso)\b/,
  ],
  legal_info: [
    /\b(informacion\s*legal|ley|leyes|codigo|articulo|legislacion)\b/,
    /\b(interdiccion|concubinato|poder\s*notarial|notoriedad|anticresis|prenda)\b/,
    /\b(divorcio|venta\s*inmueble|venta\s*vehiculo|notificacion\s*legal|citacion)\b/,
    /\b(que\s*dice\s*la\s*ley|base\s*legal|fundamento|marco\s*legal)\b/,
    /\b(institucion|gobierno|dgii|jce|catastro|registro\s*inmobiliario|migracion)\b/,
  ],
  services: [
    /\b(servicio|servicios|precio|precios|tarifa|tarifario|costo|cuanto\s*cuesta|cuanto\s*vale)\b/,
    /\b(fotocopia|impresion|impresiones|diseno|materiales|oficina)\b/,
  ],
  talk_to_lawyer: [
    /\b(hablar|comunicar|contactar|llamar|asesor|licenciado)\b/,
    /\b(persona\s*real|humano|atencion\s*personal)\b/,
  ],
  urgent: [
    /\b(urgente|emergencia|inmediato|ahora\s*mismo|lo\s*antes\s*posible|cuanto\s*antes)\b/,
  ],
  help: [
    /\b(ayuda|help|asistencia|no\s*entiendo|como\s*funciona|instrucciones)\b/,
  ],
  goodbye: [
    /\b(salir|adios|hasta\s*luego|gracias|terminar|finalizar|chao|bye)\b/,
  ],
  confirm_yes: [
    /^(1|si|sí|correcto|confirmo|confirmar|de\s*acuerdo|ok|vale|afirmativo)$/,
  ],
  confirm_no: [
    /^(2|no|incorrecto|cancelar|corregir|cambiar|negativo)$/,
  ],
  skip: [
    /^(omitir|saltar|skip|no\s*tengo|prefiero\s*no)$/,
  ],
  register: [
    /\b(registrar|registrarme|inscribir|darme\s*de\s*alta|crear\s*cuenta)\b/,
  ],
  casual: [
    /\b(jaja|haha|lol|jejeje|xd|jeje)\b/,
    /^(ok|ah|oh|wow|dale|bien|genial|excelente|perfecto|tranqui|bregamos|listo)$/,
  ],
};

// ── Legal topic detection — Dominican Republic specific ──
const LEGAL_TOPICS = {
  civil: /\b(civil|propiedad|herencia|sucesion|arrendamiento|contrato|deuda|cobro|dano|indemnizacion|interdiccion|anticresis|prenda)\b/,
  penal: /\b(penal|delito|crimen|robo|fraude|lesiones|homicidio|denuncia|ministerio\s*publico|fiscalia|procuraduria|carpeta)\b/,
  familiar: /\b(familiar|familia|divorcio|custodia|pension\s*alimenticia|alimentos|matrimonio|adopcion|guarda|concubinato|union\s*libre)\b/,
  laboral: /\b(laboral|trabajo|despido|liquidacion|prestaciones|patron|empleador|codigo\s*de\s*trabajo|salario|sueldo|ministerio\s*de\s*trabajo)\b/,
  mercantil: /\b(mercantil|sociedad|empresa|comercial|quiebra|registro\s*mercantil|pagare|cheque|letra\s*de\s*cambio)\b/,
  inmobiliario: /\b(inmobiliario|inmueble|titulo|certificado\s*de\s*titulo|registro\s*de\s*titulos|deslinde|catastro|ley\s*108|solar|terreno|apartamento|casa)\b/,
  fiscal: /\b(fiscal|impuesto|dgii|tributario|itbis|isr|contribucion|declaracion|transferencia\s*inmobiliaria)\b/,
  migratorio: /\b(migratorio|migracion|visa|residencia|pasaporte|extranjero|permiso\s*de\s*trabajo|estatus\s*migratorio)\b/,
  notarial: /\b(notarial|notario|acto\s*autentico|fe\s*publica|legalizacion|apostilla|ley\s*140|poder|acto\s*de\s*notoriedad)\b/,
};

function detectIntent(text) {
  const norm = normalize(text);

  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(norm)) {
        return intent;
      }
    }
  }
  return 'unknown';
}

function detectLegalTopic(text) {
  const norm = normalize(text);
  for (const [topic, pattern] of Object.entries(LEGAL_TOPICS)) {
    if (pattern.test(norm)) return topic;
  }
  return null;
}

function isMenuChoice(text, maxOption) {
  const num = parseInt(text.trim(), 10);
  if (!isNaN(num) && num >= 0 && num <= maxOption) return num;
  return null;
}

function parseDate(text) {
  // DD/MM/YYYY or DD-MM-YYYY
  const match = text.trim().match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const month = parseInt(match[2], 10) - 1;
  const year = parseInt(match[3], 10);

  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) {
    return null;
  }

  const now = new Date();
  now.setHours(0, 0, 0, 0);
  if (date < now) return null;

  return date;
}

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function formatDateISO(date) {
  return date.toISOString().split('T')[0];
}

function formatDateES(date) {
  return date.toLocaleDateString('es-DO', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function isValidEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

// Dominican cédula pattern: XXX-XXXXXXX-X (with or without dashes)
const CEDULA_PATTERN = /\b(\d{3})-?(\d{7})-?(\d)\b/;

function extractCedula(text) {
  const match = text.match(CEDULA_PATTERN);
  if (!match) return null;
  return { cedula: `${match[1]}-${match[2]}-${match[3]}`, raw: match[0] };
}

function isEscapeIntent(text) {
  const norm = normalize(text);
  return /\b(no quiero|cancelar|no necesito|no deseo|dejame|dejar|volver al menu|regresar al menu|no gracias|parar|detener|ya no|no me interesa)\b/.test(norm);
}

module.exports = {
  normalize,
  detectIntent,
  detectLegalTopic,
  isMenuChoice,
  isEscapeIntent,
  extractCedula,
  parseDate,
  isWeekend,
  formatDateISO,
  formatDateES,
  isValidEmail,
};
