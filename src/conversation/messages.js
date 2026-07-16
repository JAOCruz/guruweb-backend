const { buildListMessage } = require('../whatsapp/interactive');

// All user-facing messages in formal/professional Spanish for DR legal services

const MSG = {
  // ── Greeting & Welcome ──
  WELCOME_NEW:
    `🦉 ¡Buenas! Bienvenido/a a *Gurú Soluciones*.\n\n` +
    `¿En qué podemos orientarle hoy?`,

  WELCOME_NEW_SHORT:
    `🦉 ¡Buenas! Bienvenido/a a *Gurú Soluciones*.\n\n` +
    `¿En qué podemos orientarle hoy?`,

  WELCOME_BACK: (name) =>
    `🦉 ¡Buenas *${name}*! Qué bueno verle de nuevo.\n\n¿En qué le ayudamos hoy?`,

  // ── Main Menu ──
  MAIN_MENU:
    `🦉 *Menú Principal — Gurú Soluciones*\n\n` +
    `¿En qué puedo orientarle?\n\n` +
    `1️⃣ Nueva consulta legal\n` +
    `2️⃣ Agendar una cita\n` +
    `3️⃣ Enviar documentos\n` +
    `4️⃣ Consultar estado de mi caso\n` +
    `5️⃣ Información legal (Leyes RD)\n` +
    `6️⃣ Servicios y precios\n` +
    `7️⃣ Hablar con un abogado\n` +
    `8️⃣ Generar Factura\n` +
    `0️⃣ Finalizar conversación`,

  MENU_HINT:
    `_Escriba *"menu"* para ver las opciones disponibles._`,

  INVALID_OPTION:
    `Disculpe, no he comprendido su selección. Por favor, elija una de las opciones indicadas con el número correspondiente.`,

  // ── Intake Flow ──
  INTAKE_ASK_NAME:
    `Para iniciar su registro, por favor indíquenos su *nombre completo* tal como aparece en su cédula de identidad.`,

  INTAKE_ASK_EMAIL:
    `Gracias. Ahora, ¿podría proporcionarnos su *correo electrónico* para enviarle información relevante?\n\n(Escriba "omitir" si prefiere no proporcionarlo)`,

  INTAKE_ASK_ADDRESS:
    `¿Cuál es su *domicilio* actual?\n\n(Escriba "omitir" si prefiere no proporcionarlo en este momento)`,

  INTAKE_ASK_CASE_TYPE:
    `¿Qué *tipo de asunto legal* necesita atender?\n\n` +
    `1️⃣ Derecho Civil\n` +
    `2️⃣ Derecho Penal\n` +
    `3️⃣ Derecho de Familia\n` +
    `4️⃣ Derecho Laboral\n` +
    `5️⃣ Derecho Mercantil / Comercial\n` +
    `6️⃣ Derecho Inmobiliario\n` +
    `7️⃣ Derecho Tributario / Fiscal\n` +
    `8️⃣ Derecho Migratorio\n` +
    `9️⃣ Otro`,

  INTAKE_ASK_DESCRIPTION:
    `Por favor, describa brevemente su *situación legal*. Cuanta más información nos proporcione, mejor podremos orientarle.`,

  INTAKE_ASK_URGENCY:
    `¿Cuál es el *nivel de urgencia* de su caso?\n\n` +
    `1️⃣ 🔴 Urgente — Requiere atención inmediata\n` +
    `2️⃣ 🟡 Moderado — Dentro de los próximos días\n` +
    `3️⃣ 🟢 Normal — Sin prisa, consulta general`,

  INTAKE_CONFIRM: (data) =>
    `📝 *Resumen de su consulta:*\n\n` +
    `👤 Nombre: ${data.name}\n` +
    `📧 Correo: ${data.email || 'No proporcionado'}\n` +
    `📍 Domicilio: ${data.address || 'No proporcionado'}\n` +
    `⚖️ Área legal: ${data.caseType}\n` +
    `📄 Descripción: ${data.description}\n` +
    `🚨 Urgencia: ${data.urgency}\n\n` +
    `¿Los datos son correctos?\n\n` +
    `1️⃣ Sí, confirmar\n` +
    `2️⃣ No, deseo corregir`,

  INTAKE_SUCCESS: (caseNumber) =>
    `✅ Su consulta ha sido registrada exitosamente.\n\n` +
    `📋 *Número de expediente:* ${caseNumber}\n\n` +
    `Un abogado especializado revisará su caso y se pondrá en contacto con usted a la brevedad.\n\n` +
    `Guarde su número de expediente para futuras consultas.`,

  INTAKE_QUICK_QUESTION:
    `Con gusto le atendemos. Por favor, escriba su *consulta* y un abogado le responderá a la brevedad.`,

  INTAKE_QUICK_RECEIVED:
    `Hemos recibido su consulta. Un miembro de nuestro equipo legal le responderá lo antes posible.\n\nSi desea registrarse para un seguimiento más detallado, escriba *"registrarme"*.`,

  // ── Appointment Flow ──
  APPOINTMENT_INTRO:
    `📅 *Agendar Cita*\n\n¿Qué tipo de cita desea agendar?\n\n` +
    `1️⃣ Consulta inicial\n` +
    `2️⃣ Seguimiento de caso\n` +
    `3️⃣ Revisión de documentos\n` +
    `4️⃣ Audiencia / Preparación`,

  APPOINTMENT_ASK_DATE:
    `¿Para qué *fecha* desea agendar su cita?\n\n` +
    `Por favor, indique la fecha en formato *DD/MM/AAAA*\n` +
    `(Ejemplo: 15/03/2026)`,

  APPOINTMENT_INVALID_DATE:
    `La fecha indicada no es válida o ya ha pasado. Por favor, ingrese una fecha futura en formato *DD/MM/AAAA*.`,

  APPOINTMENT_NO_WEEKEND:
    `Lo sentimos, no atendemos los fines de semana. Por favor, seleccione un día de lunes a viernes.`,

  APPOINTMENT_SHOW_SLOTS: (date, slots) =>
    `📅 Horarios disponibles para el *${date}*:\n\n` +
    slots.map((s, i) => `${i + 1}️⃣ ${s} hrs`).join('\n') +
    `\n\nSeleccione el número del horario deseado.`,

  APPOINTMENT_NO_SLOTS:
    `Lo sentimos, no hay horarios disponibles para la fecha seleccionada. Por favor, elija otra fecha.`,

  APPOINTMENT_CONFIRM: (data) =>
    `📅 *Confirmación de Cita:*\n\n` +
    `📌 Tipo: ${data.type}\n` +
    `📆 Fecha: ${data.date}\n` +
    `🕐 Hora: ${data.time} hrs\n` +
    `⏱️ Duración estimada: ${data.duration} minutos\n\n` +
    `¿Confirma esta cita?\n\n` +
    `1️⃣ Sí, confirmar\n` +
    `2️⃣ No, elegir otro horario`,

  APPOINTMENT_SUCCESS: (data) =>
    `✅ Su cita ha sido agendada exitosamente.\n\n` +
    `📆 ${data.date} a las ${data.time} hrs\n\n` +
    `Le enviaremos un recordatorio antes de su cita. Si necesita cancelar o reagendar, no dude en comunicarse con nosotros.`,

  APPOINTMENT_CANCELLED:
    `Su solicitud de cita ha sido cancelada. Puede agendar una nueva cita en cualquier momento desde el menú principal.`,

  // ── Document Flow ──
  DOCUMENT_INTRO:
    `📎 *Envío de Documentos*\n\n` +
    `¿Qué tipo de documento desea enviar?\n\n` +
    `1️⃣ Cédula de identidad / Pasaporte\n` +
    `2️⃣ Comprobante de domicilio\n` +
    `3️⃣ Contrato o acuerdo\n` +
    `4️⃣ Poder notarial\n` +
    `5️⃣ Acta del Estado Civil (nacimiento/matrimonio)\n` +
    `6️⃣ Documento judicial / Certificado de Título\n` +
    `7️⃣ Otro documento`,

  DOCUMENT_ASK_DESCRIPTION:
    `Por favor, proporcione una *breve descripción* del documento que va a enviar.`,

  DOCUMENT_ASK_FILE:
    `Ahora, por favor *envíe el archivo* (imagen, PDF o documento).\n\n` +
    `⚠️ *Aviso de privacidad:* Sus documentos serán tratados con estricta confidencialidad conforme a la legislación vigente de protección de datos personales de la República Dominicana.`,

  DOCUMENT_RECEIVED: (docId) =>
    `✅ Documento recibido correctamente.\n\n` +
    `📋 *Referencia:* DOC-${docId}\n\n` +
    `Nuestro equipo revisará el documento y le notificará si se requiere información adicional.\n\n` +
    `¿Desea enviar otro documento?\n\n` +
    `1️⃣ Sí, enviar otro\n` +
    `2️⃣ No, regresar al menú`,

  DOCUMENT_INVALID_FILE:
    `No hemos podido recibir el archivo. Por favor, envíe un documento en formato *imagen, PDF o documento de texto*.`,

  DOCUMENT_FOR_REDACTION:
    `📝 *Servicio de Redacción*\n\n` +
    `Para nuestro servicio de redacción de documentos legales, por favor envíe el borrador o la información base que desea que redactemos.\n\n` +
    `Nuestro equipo preparará el documento y se lo enviará para su revisión.`,

  // ── Case Status Flow ──
  STATUS_ASK_NUMBER:
    `🔍 *Consulta de Estado*\n\n` +
    `Por favor, ingrese su *número de expediente* para consultar el estado de su caso.\n\n` +
    `(Ejemplo: CASO-001)`,

  STATUS_FOUND: (c) =>
    `📋 *Estado de su Expediente*\n\n` +
    `📁 Expediente: ${c.case_number}\n` +
    `📌 Asunto: ${c.title}\n` +
    `⚖️ Tipo: ${c.case_type || 'No especificado'}\n` +
    `📊 Estado: ${STATUS_LABELS[c.status] || c.status}\n` +
    `🏛️ Tribunal: ${c.court || 'Pendiente de asignar'}\n` +
    `📅 Próxima audiencia: ${c.next_hearing ? formatDate(c.next_hearing) : 'Sin fecha programada'}\n\n` +
    `¿Desea realizar alguna otra consulta?\n\n` +
    `1️⃣ Consultar otro expediente\n` +
    `2️⃣ Regresar al menú principal`,

  STATUS_NOT_FOUND:
    `No se encontró ningún expediente con ese número. Por favor, verifique el número e intente nuevamente.\n\n` +
    `Si no recuerda su número de expediente, escriba *"ayuda"* y un asesor le asistirá.`,

  STATUS_NO_CASES:
    `No tiene expedientes registrados actualmente. Si desea iniciar una consulta legal, seleccione la opción 1 del menú principal.`,

  STATUS_LIST: (cases) =>
    `📂 *Sus expedientes activos:*\n\n` +
    cases.map((c, i) =>
      `${i + 1}️⃣ *${c.case_number}* — ${c.title}\n   Estado: ${STATUS_LABELS[c.status] || c.status}`
    ).join('\n\n') +
    `\n\nIngrese el número de expediente que desea consultar, o escriba *"menu"* para regresar.`,

  // ── Talk to Lawyer ──
  TALK_TO_LAWYER:
    `Un abogado de nuestro equipo se comunicará con usted a la brevedad.\n\n` +
    `⏰ Horario de atención: Lunes a Viernes, 9:00 a 18:00 hrs.\n\n` +
    `Si su asunto es urgente fuera de horario, por favor indíquelo escribiendo *"urgente"*.`,

  TALK_TO_LAWYER_URGENT:
    `Hemos marcado su solicitud como *urgente*. Un abogado de guardia se pondrá en contacto con usted lo antes posible.`,

  // ── Session / General ──
  SESSION_EXPIRED:
    `Su sesión ha expirado por inactividad. Escriba cualquier mensaje para iniciar una nueva conversación.`,

  GOODBYE:
    `🦉 Gracias por comunicarse con *Gurú Soluciones*. Ha sido un placer asistirle.\n\n` +
    `Si necesita orientación legal en el futuro, no dude en escribirnos. ¡Que tenga un excelente día!`,

  ERROR_GENERAL:
    `Disculpe, ha ocurrido un error en nuestro sistema. Por favor, intente nuevamente en unos momentos o comuníquese directamente a nuestras oficinas.`,

  HELP:
    `🦉 *Guía de El Gurú*\n\n` +
    `Puede utilizar los siguientes comandos en cualquier momento:\n\n` +
    `• *"menu"* — Regresar al menú principal\n` +
    `• *"cita"* — Agendar una cita\n` +
    `• *"estado"* — Consultar estado de caso\n` +
    `• *"leyes"* — Información legal RD\n` +
    `• *"servicios"* — Ver precios y servicios\n` +
    `• *"ayuda"* — Ver este mensaje\n` +
    `• *"salir"* — Finalizar conversación`,

  PRIVACY_NOTICE:
    `🔒 *Aviso de Privacidad*\n\n` +
    `Sus datos personales serán tratados conforme a nuestra política de privacidad y la legislación vigente en la República Dominicana en materia de protección de datos personales. ` +
    `La información proporcionada será utilizada exclusivamente para la prestación de servicios legales.`,
};

const STATUS_LABELS = {
  open: 'Abierto',
  in_progress: 'En trámite',
  pending_docs: 'Pendiente de documentos',
  hearing_scheduled: 'Audiencia programada',
  resolved: 'Resuelto',
  closed: 'Cerrado',
  archived: 'Archivado',
  // Certification workflow
  new: 'Nuevo',
  pending_payment: 'Pendiente de pago',
  awaiting_institution: 'En espera de institución',
  rejected: 'Rechazado / Corregir',
  completed: 'Completado',
  delivered: 'Entregado',
  cancelled: 'Cancelado',
  escalated: 'Escalado',
  paid: 'Pagado',
};

const CERTIFICATION_NEXT_STEP = {
  new: 'Estamos preparando su solicitud y documentos iniciales.',
  pending_payment: 'Su trámite está pendiente de pago. Una vez confirmado, iniciamos el proceso ante la institución.',
  in_progress: 'Su trámite está en proceso interno. Le notificaremos cuando enviemos o recibamos respuesta de la institución.',
  awaiting_institution: 'Su solicitud fue enviada a la institución correspondiente. Estamos a la espera de su respuesta oficial.',
  rejected: 'La institución solicitó correcciones. Un asesor se contactará con usted para indicarle los pasos a seguir.',
  completed: 'Su documento está listo. Coordinaremos la entrega o retiro a la brevedad.',
  delivered: 'Su trámite fue entregado. Si necesita algo más, estamos a su disposición.',
  closed: 'El caso fue cerrado.',
  cancelled: 'El caso fue cancelado.',
  escalated: 'El caso fue escalado a un especialista para revisión.',
  paid: 'Pago confirmado. Iniciaremos el trámite ante la institución.',
};

const CASE_TYPES = {
  '1': 'Derecho Civil',
  '2': 'Derecho Penal',
  '3': 'Derecho de Familia',
  '4': 'Derecho Laboral',
  '5': 'Derecho Mercantil / Comercial',
  '6': 'Derecho Inmobiliario',
  '7': 'Derecho Tributario / Fiscal',
  '8': 'Derecho Migratorio',
  '9': 'Otro',
};

const URGENCY_LEVELS = {
  '1': 'Urgente',
  '2': 'Moderado',
  '3': 'Normal',
};

const APPOINTMENT_TYPES = {
  '1': 'Consulta inicial',
  '2': 'Seguimiento de caso',
  '3': 'Revisión de documentos',
  '4': 'Audiencia / Preparación',
};

const DOCUMENT_TYPES = {
  '1': 'Cédula de identidad / Pasaporte',
  '2': 'Comprobante de domicilio',
  '3': 'Contrato o acuerdo',
  '4': 'Poder notarial',
  '5': 'Acta del Estado Civil',
  '6': 'Documento judicial / Certificado de Título',
  '7': 'Otro documento',
};

// Interactive list message definitions (WhatsApp native list pickers)
const LIST = {
  MAIN_MENU: buildListMessage(
    '🦉 *Menú Principal — Gurú Soluciones*\n\n¿En qué puedo orientarle?',
    'Ver opciones',
    [{
      title: 'Servicios',
      rows: [
        { title: 'Nueva consulta legal', rowId: '1', description: 'Iniciar un caso o consulta' },
        { title: 'Agendar una cita', rowId: '2', description: 'Programar cita con abogado' },
        { title: 'Enviar documentos', rowId: '3', description: 'Subir documentos al sistema' },
        { title: 'Estado de mi caso', rowId: '4', description: 'Consultar expediente activo' },
        { title: 'Información legal (RD)', rowId: '5', description: 'Leyes y normativas' },
        { title: 'Servicios y precios', rowId: '6', description: 'Tarifario de servicios' },
        { title: 'Hablar con un abogado', rowId: '7', description: 'Contactar a un profesional' },
        { title: 'Finalizar conversación', rowId: '0', description: 'Cerrar esta sesión' },
      ],
    }]
  ),

  CASE_TYPE: buildListMessage(
    '¿Qué *tipo de asunto legal* necesita atender?',
    'Seleccionar tipo',
    [{
      title: 'Áreas del Derecho',
      rows: [
        { title: 'Derecho Civil', rowId: '1' },
        { title: 'Derecho Penal', rowId: '2' },
        { title: 'Derecho de Familia', rowId: '3' },
        { title: 'Derecho Laboral', rowId: '4' },
        { title: 'Derecho Mercantil', rowId: '5', description: 'Comercial y societario' },
        { title: 'Derecho Inmobiliario', rowId: '6' },
        { title: 'Derecho Tributario', rowId: '7', description: 'Fiscal' },
        { title: 'Derecho Migratorio', rowId: '8' },
        { title: 'Otro', rowId: '9' },
      ],
    }]
  ),

  URGENCY: buildListMessage(
    '¿Cuál es el *nivel de urgencia* de su caso?',
    'Seleccionar urgencia',
    [{
      title: 'Nivel de urgencia',
      rows: [
        { title: 'Urgente', rowId: '1', description: 'Requiere atención inmediata' },
        { title: 'Moderado', rowId: '2', description: 'Dentro de los próximos días' },
        { title: 'Normal', rowId: '3', description: 'Sin prisa, consulta general' },
      ],
    }]
  ),

  CONFIRM: buildListMessage(
    '¿Los datos son correctos?',
    'Confirmar',
    [{
      title: 'Opciones',
      rows: [
        { title: 'Sí, confirmar', rowId: '1' },
        { title: 'No, deseo corregir', rowId: '2' },
      ],
    }]
  ),

  INTAKE_CONFIRM: (data) => buildListMessage(
    `📝 *Resumen de su consulta:*\n\n` +
    `👤 Nombre: ${data.name}\n` +
    `📧 Correo: ${data.email || 'No proporcionado'}\n` +
    `📍 Domicilio: ${data.address || 'No proporcionado'}\n` +
    `⚖️ Área legal: ${data.caseType}\n` +
    `📄 Descripción: ${data.description}\n` +
    `🚨 Urgencia: ${data.urgency}`,
    'Confirmar datos',
    [{
      title: 'Opciones',
      rows: [
        { title: 'Sí, confirmar', rowId: '1' },
        { title: 'No, deseo corregir', rowId: '2' },
      ],
    }]
  ),

  APPOINTMENT_TYPE: buildListMessage(
    '📅 *Agendar Cita*\n\n¿Qué tipo de cita desea agendar?',
    'Seleccionar tipo',
    [{
      title: 'Tipos de cita',
      rows: [
        { title: 'Consulta inicial', rowId: '1' },
        { title: 'Seguimiento de caso', rowId: '2' },
        { title: 'Revisión de documentos', rowId: '3' },
        { title: 'Audiencia / Preparación', rowId: '4' },
      ],
    }]
  ),

  APPOINTMENT_SLOTS: (date, slots) => buildListMessage(
    `📅 Horarios disponibles para el *${date}*:`,
    'Seleccionar horario',
    [{
      title: 'Horarios disponibles',
      rows: slots.map((s, i) => ({ title: `${s} hrs`, rowId: String(i + 1) })),
    }]
  ),

  APPOINTMENT_CONFIRM: (data) => buildListMessage(
    `📅 *Confirmación de Cita:*\n\n` +
    `📌 Tipo: ${data.type}\n` +
    `📆 Fecha: ${data.date}\n` +
    `🕐 Hora: ${data.time} hrs\n` +
    `⏱️ Duración estimada: ${data.duration} minutos`,
    'Confirmar cita',
    [{
      title: 'Opciones',
      rows: [
        { title: 'Sí, confirmar', rowId: '1' },
        { title: 'No, elegir otro horario', rowId: '2' },
      ],
    }]
  ),

  DOCUMENT_TYPE: buildListMessage(
    '📎 *Envío de Documentos*\n\n¿Qué tipo de documento desea enviar?',
    'Seleccionar tipo',
    [{
      title: 'Tipos de documento',
      rows: [
        { title: 'Cédula / Pasaporte', rowId: '1', description: 'Documento de identidad' },
        { title: 'Comprobante de domicilio', rowId: '2' },
        { title: 'Contrato o acuerdo', rowId: '3' },
        { title: 'Poder notarial', rowId: '4' },
        { title: 'Acta del Estado Civil', rowId: '5', description: 'Nacimiento, matrimonio, etc.' },
        { title: 'Documento judicial', rowId: '6', description: 'Certificado de Título, etc.' },
        { title: 'Otro documento', rowId: '7' },
      ],
    }]
  ),

  DOCUMENT_RECEIVED: (docId) => buildListMessage(
    `✅ Documento recibido correctamente.\n\n📋 *Referencia:* DOC-${docId}\n\nNuestro equipo revisará el documento.`,
    'Elegir acción',
    [{
      title: 'Opciones',
      rows: [
        { title: 'Enviar otro documento', rowId: '1' },
        { title: 'Regresar al menú', rowId: '2' },
      ],
    }]
  ),

  WELCOME_CHOICE: buildListMessage(
    '🦉 ¡Saludos! Soy *El Gurú*, su sabio búho legal de *Gurú Soluciones*.\n\nEstoy aquí para iluminar su camino en cualquier asunto legal dentro de la República Dominicana.',
    'Comenzar',
    [{
      title: 'Opciones',
      rows: [
        { title: 'Registrarme', rowId: '1', description: 'Atención personalizada completa' },
        { title: 'Consulta rápida', rowId: '2', description: 'Solo tengo una pregunta' },
      ],
    }]
  ),

  POST_CASE_VIEW: buildListMessage(
    '¿Desea realizar alguna otra consulta?',
    'Elegir acción',
    [{
      title: 'Opciones',
      rows: [
        { title: 'Consultar otro expediente', rowId: '1' },
        { title: 'Regresar al menú principal', rowId: '2' },
      ],
    }]
  ),

  CASE_LIST: (cases) => buildListMessage(
    '📂 *Sus expedientes activos:*',
    'Seleccionar expediente',
    [{
      title: 'Expedientes',
      rows: cases.map((c, i) => ({
        title: c.case_number,
        rowId: String(i + 1),
        description: `${c.title} — ${STATUS_LABELS[c.status] || c.status}`,
      })),
    }]
  ),
};

function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString('es-DO', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

module.exports = { MSG, LIST, STATUS_LABELS, CERTIFICATION_NEXT_STEP, CASE_TYPES, URGENCY_LEVELS, APPOINTMENT_TYPES, DOCUMENT_TYPES, formatDate };
