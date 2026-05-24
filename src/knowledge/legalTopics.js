// Dominican Republic Legal Knowledge Base — structured from PDF educativo and DR legal framework

const LEGAL_TOPICS = {

  interdiccion: {
    title: 'Interdicción en Contratos Legales',
    keywords: ['interdiccion', 'interdicto', 'incapacidad', 'tutor', 'nulo', 'capacidad mental', 'enfermedad mental'],
    content:
      `⚖️ *Interdicción en Contratos Legales*\n\n` +
      `La interdicción es una medida de protección dictada por un tribunal para personas que no pueden tomar decisiones por sí mismas (por ejemplo, por enfermedad mental grave).\n\n` +
      `📌 *Puntos clave:*\n\n` +
      `1️⃣ *Efecto en Contratos:* Un contrato firmado por una persona declarada interdicta es *NULO de pleno derecho*.\n\n` +
      `2️⃣ *Excepción Notarial:* Puede ser válido solo si se incluye una cláusula específica y se cuenta con *dos (2) testigos* ante un notario público.\n\n` +
      `3️⃣ *Rol del Tutor:* El tribunal nombra un tutor, quien es la *única persona autorizada* para actuar y firmar en nombre del interdicto.\n\n` +
      `La ley le quita la capacidad de firmar y manejar bienes para protegerlo de la explotación.`,
    law_refs: ['Código Civil Dominicano, Arts. 489-512'],
  },

  concubinato: {
    title: 'Concubinato y Declaración Jurada',
    keywords: ['concubinato', 'union libre', 'union consensual', 'declaracion jurada', 'bienes comunes', 'convivencia'],
    content:
      `⚖️ *Concubinato y Declaración Jurada*\n\n` +
      `El concubinato (o unión libre) es la relación estable y pública, reconocida en República Dominicana.\n\n` +
      `📌 *Aspectos fundamentales:*\n\n` +
      `• *Unión Estable:* Relación pública y continua entre dos personas que viven como esposos.\n\n` +
      `• *Declaración Jurada:* Documento notarial donde se certifica el estado civil y la situación económica del concubinato.\n\n` +
      `• *Implicación de Bienes:* Un juez puede reconocer que los bienes adquiridos durante la unión pertenecen a ambos en un *50%*, bajo el régimen de comunidad de bienes.\n\n` +
      `Las declaraciones juradas son cruciales para formalizar y certificar este estado ante terceros o en procesos judiciales.`,
    law_refs: ['Constitución RD Art. 55.5', 'Ley 659 sobre Actos del Estado Civil'],
  },

  divorcio: {
    title: 'Divorcio por Mutuo Consentimiento',
    keywords: ['divorcio', 'mutuo consentimiento', 'separacion', 'acta de convenciones', 'pension alimenticia', 'guarda', 'custodia', 'reparticion de bienes'],
    content:
      `⚖️ *Divorcio por Mutuo Consentimiento*\n\n` +
      `Es el tipo de divorcio más rápido y amigable, basado en el acuerdo total de los cónyuges.\n\n` +
      `📋 *Documento clave:* Acta de Convenciones y Estipulaciones, que detalla todos los acuerdos post-matrimoniales.\n\n` +
      `📌 *Puntos que se acuerdan:*\n\n` +
      `• *Guarda y Custodia:* Con quién vivirán los hijos menores y el régimen de visitas.\n` +
      `• *Pensión Alimenticia:* Determinación de la obligación de pensión y su duración.\n` +
      `• *Repartición de Bienes:* Inventario y división equitativa de todos los bienes adquiridos durante el matrimonio (comunidad legal).\n\n` +
      `El juez revisa el acuerdo para garantizar que no haya perjuicio a los hijos y luego dicta la sentencia de divorcio.`,
    law_refs: ['Ley 1306-bis sobre Divorcio', 'Código Civil Dominicano'],
  },

  poderes: {
    title: 'Poderes en Contratos Legales',
    keywords: ['poder', 'poder notarial', 'poder especial', 'poder general', 'poderdante', 'apoderado', 'representacion', 'mandato'],
    content:
      `⚖️ *Poderes en Contratos Legales*\n\n` +
      `Un Poder es un "acto de apoderamiento" notarial donde el poderdante autoriza al apoderado a actuar en su nombre.\n\n` +
      `👤 *Poderdante:* Persona que otorga la autorización (el que presta la firma).\n` +
      `👤 *Apoderado:* Persona autorizada para actuar en nombre del poderdante.\n\n` +
      `📌 *Tipos de Poderes:*\n\n` +
      `1️⃣ *Poder Especial:* Otorga capacidad para un acto único y específico (ej. vender una casa, firmar un contrato).\n\n` +
      `2️⃣ *Poder General:* Otorga capacidad para una amplia gama de actos (ej. administrar todos mis bienes). Más delicado.\n\n` +
      `Es fundamental para transacciones a distancia o cuando se requiere representación legal.`,
    law_refs: ['Código Civil Dominicano, Arts. 1984-2010', 'Ley 140-15 del Notariado'],
  },

  acto_notoriedad: {
    title: 'Acto de Notoriedad y Fe Pública',
    keywords: ['acto de notoriedad', 'fe publica', 'notario', 'testigos', 'sucesion', 'herederos', 'perjurio', 'prueba supletoria'],
    content:
      `⚖️ *Acto de Notoriedad y Fe Pública*\n\n` +
      `Es un documento notarial clave que se usa para probar un hecho conocido por muchas personas pero del cual no hay un registro oficial fácil de obtener.\n\n` +
      `📌 *Características:*\n\n` +
      `• *Declaración Juramentada:* Múltiples testigos (generalmente siete) juran ante el notario que el hecho es cierto y conocido.\n\n` +
      `• *Uso en Sucesiones:* Vital para determinar herederos cuando hay dudas o falta de documentos oficiales.\n\n` +
      `• *Prueba Supletoria:* Sirve como prueba legal ante la ausencia de un documento oficial, dotando al hecho de autenticidad legal.\n\n` +
      `⚠️ El notario redacta un acta, y este documento adquiere "fe pública", presumiéndose como cierto. *Mentir como testigo en este acto es perjurio.*`,
    law_refs: ['Ley 140-15 del Notariado Dominicano', 'Código Civil Dominicano'],
  },

  venta_vehiculo: {
    title: 'Contrato Notarial: Venta de Vehículo',
    keywords: ['venta vehiculo', 'vehiculo', 'carro', 'motor', 'matricula', 'traspaso', 'ley 492', 'dgii'],
    content:
      `⚖️ *Venta de Vehículo — Contrato Notarial*\n\n` +
      `La transferencia de vehículos se rige por la *Ley 492-08*, complementando el Código Civil.\n\n` +
      `📌 *Proceso legal:*\n\n` +
      `1️⃣ *Autenticidad Notarial:* El notario certifica la identidad de las partes, verifica la ausencia de gravámenes y la legalidad del acto.\n\n` +
      `2️⃣ *Obligación del Vendedor:* Garantizar la entrega del vehículo libre de vicios ocultos (Art. 1641 C.C.).\n\n` +
      `3️⃣ *Responsabilidad del Comprador:* Diligenciar el traspaso ante la *DGII* para evitar multas futuras al vendedor.\n\n` +
      `🔗 Para traspaso de vehículos, visite la DGII: https://dgii.gov.do\n\n` +
      `El contrato notarial brinda seguridad jurídica, protegiendo tanto al comprador de fraudes como al vendedor de responsabilidades post-venta.`,
    law_refs: ['Ley 492-08', 'Código Civil Dominicano, Art. 1641'],
  },

  venta_inmueble: {
    title: 'Contrato Notarial: Venta de Inmueble',
    keywords: ['venta inmueble', 'inmueble', 'casa', 'apartamento', 'terreno', 'solar', 'propiedad', 'registro de titulos', 'titulo', 'ley 108'],
    content:
      `⚖️ *Venta de Inmueble — Contrato Notarial*\n\n` +
      `Regulada por la *Ley 108-05 de Registro Inmobiliario*. Requiere obligatoriamente un *acto notarial auténtico* para su inscripción en el Registro de Títulos.\n\n` +
      `📌 *Requisitos fundamentales:*\n\n` +
      `• *Autenticación:* Acto notarial auténtico obligatorio.\n` +
      `• *Pago de impuestos:* Impuesto de Transferencia Patrimonial (ITP) ante la DGII.\n` +
      `• *Registro:* Inscripción en el Registro de Títulos para oponibilidad a terceros.\n` +
      `• *Transferencia irrevocable:* Una vez registrada.\n\n` +
      `⚠️ El vendedor responde por *evicción* (si el comprador es desalojado) y por *saneamiento de vicios*.\n\n` +
      `🔗 Registro Inmobiliario: https://ri.gob.do\n` +
      `🔗 Catastro Nacional: https://www.catastro.gob.do\n` +
      `🔗 DGII (impuestos): https://dgii.gov.do`,
    law_refs: ['Ley 108-05 de Registro Inmobiliario', 'Código Civil Dominicano'],
  },

  anticresis_prenda: {
    title: 'Anticresis y Prenda — Contratos de Garantía',
    keywords: ['anticresis', 'prenda', 'garantia', 'hipoteca', 'acreedor', 'deuda', 'bien mueble', 'bien inmueble'],
    content:
      `⚖️ *Anticresis y Prenda*\n\n` +
      `Ambos son contratos de garantía regidos por el Código Civil. No transfieren propiedad, sino posesión temporal al acreedor hasta que la deuda sea saldada.\n\n` +
      `📌 *Prenda:*\n` +
      `Garantía de bienes *MUEBLES* (ej. joyas, equipos) como respaldo de una deuda. Se entrega la posesión al acreedor.\n\n` +
      `📌 *Anticresis:*\n` +
      `Garantía de bienes *INMUEBLES*. El acreedor percibe los frutos (ej. alquileres) y los imputa a los intereses y capital de la deuda.\n\n` +
      `⚠️ El acreedor está obligado a *conservar el bien* y rendir cuentas detalladas de los frutos percibidos.\n\n` +
      `Ambos requieren forma escrita y el mal uso del bien por el acreedor puede llevar a la anulación del contrato o al pago de daños y perjuicios.`,
    law_refs: ['Código Civil Dominicano'],
  },

  notificaciones: {
    title: 'Notificaciones y Citaciones Legales',
    keywords: ['notificacion', 'citacion', 'alguacil', 'emplazamiento', 'mandamiento', 'demanda', 'embargo', 'desalojo'],
    content:
      `⚖️ *Notificaciones y Citaciones Legales*\n\n` +
      `Son actos formales fundamentales del debido proceso, regulados por el Código de Procedimiento Civil.\n\n` +
      `📌 *Rol del Alguacil:*\n` +
      `Actúa como agente público, certificando la entrega y la hora de notificación, lo que da fe pública al acto.\n\n` +
      `⚠️ *Requisito de Forma:* La ausencia de formalidades (fecha, hora, constancia de entrega) puede provocar la *nulidad* de todo el procedimiento.\n\n` +
      `📋 *Categorías:*\n\n` +
      `1️⃣ *Citaciones Judiciales:* Para comparecer ante un tribunal en fecha y hora específicas.\n` +
      `2️⃣ *Emplazamientos:* Acto formal que marca el inicio de una demanda, otorgando un plazo perentorio para responder.\n` +
      `3️⃣ *Notificaciones Extrajudiciales:* Comunicaciones privadas o administrativas con validez legal.\n` +
      `4️⃣ *Mandamientos:* Órdenes específicas y ejecutivas del tribunal (ej. embargos, desalojos).`,
    law_refs: ['Código de Procedimiento Civil Dominicano'],
  },
};

module.exports = LEGAL_TOPICS;
