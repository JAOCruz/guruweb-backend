/**
 * Guru Soluciones — Official Service Catalog & Pricing
 * Source: GURU_PRECIOS_OFICIALES.pdf (uploaded by Leo, March 2026)
 * All prices in RD$ (Dominican Pesos)
 */

const SERVICE_CATEGORIES = {

  // ═══════════════════════════════════════════════════════
  // LEGAL SERVICES
  // ═══════════════════════════════════════════════════════

  ventas: {
    name: 'Actos de Venta y Contratos Traslativos',
    emoji: '🚗',
    legal: true,
    description: 'Contratos de compra-venta de bienes muebles e inmuebles. Precio de notarización según valor del bien (S/E/A).',
    items: [
      // Redacción base
      { name: 'Redacción contrato de venta', modalidad: 'bajo_firma', prices: { desde: 200, hasta: 500 } },
      { name: 'Cesión de crédito', modalidad: 'bajo_firma', prices: { unico: 250 } },
      // Notarización por valor del bien (S/E/A)
      { name: 'Notarización — S (hasta RD$150K)', modalidad: 'autentico', prices: { unico: 500 } },
      { name: 'Notarización — E (RD$150K – 500K)', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Notarización — E (RD$600K – 1M)', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Notarización — A (RD$1M – 3M)', modalidad: 'autentico', prices: { unico: 2000 } },
      { name: 'Notarización — A (RD$3M – 5M)', modalidad: 'autentico', prices: { unico: 4000 } },
      { name: 'Notarización — A (RD$5M – 8M)', modalidad: 'autentico', prices: { unico: 5000 } },
      { name: 'Notarización — A (RD$8M – 10M)', modalidad: 'autentico', prices: { unico: 10000 } },
      // Auténticos
      { name: 'Compulsa notarial', modalidad: 'autentico', prices: { unico: 250 } },
    ]
  },

  traslativos: {
    name: 'Contratos Traslativos de Propiedad',
    emoji: '🏠',
    legal: true,
    description: 'Bienes inmuebles y muebles registrables. Precio de notarización por valor del bien (S/E/A).',
    items: [
      { name: 'Hipoteca inmueble', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Permuta', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Promesa / Intención de compra', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Contrato de anticresis', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Aporte en naturaleza', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Contrato de prenda', modalidad: 'autentico', prices: { unico: 1000 } },
    ]
  },

  rentas: {
    name: 'Contratos de Renta / Alquiler',
    emoji: '🔑',
    legal: true,
    description: 'Alquiler de inmuebles, vehículos y terrenos. Redacción + notarización según complejidad S/E/A.',
    items: [
      { name: 'Alquiler vivienda — S', modalidad: 'combo', prices: { redaccion: 300, notarizacion: 500 } },
      { name: 'Alquiler vivienda — E', modalidad: 'combo', prices: { redaccion: 400, notarizacion: 700 } },
      { name: 'Alquiler vivienda — A', modalidad: 'combo', prices: { redaccion: 600, notarizacion: 1000 } },
      { name: 'Alquiler local comercial — S', modalidad: 'combo', prices: { redaccion: 400, notarizacion: 700 } },
      { name: 'Alquiler local comercial — E', modalidad: 'combo', prices: { redaccion: 600, notarizacion: 1000 } },
      { name: 'Alquiler local comercial — A', modalidad: 'combo', prices: { redaccion: 1000, notarizacion: 2000 } },
      { name: 'Renta de vehículo — S', modalidad: 'combo', prices: { redaccion: 300, notarizacion: 700 } },
      { name: 'Renta de vehículo — E', modalidad: 'combo', prices: { redaccion: 500, notarizacion: 1000 } },
      { name: 'Renta de vehículo — A', modalidad: 'combo', prices: { redaccion: 1000, notarizacion: 2500 } },
      { name: 'Alquiler nave comercial — S', modalidad: 'combo', prices: { redaccion: 500, notarizacion: 1000 } },
      { name: 'Alquiler nave comercial — E', modalidad: 'combo', prices: { redaccion: 1000, notarizacion: 2000 } },
      { name: 'Alquiler nave comercial — A', modalidad: 'combo', prices: { redaccion: 1500, notarizacion: 3000 } },
    ]
  },

  acuerdos: {
    name: 'Acuerdos, Hereditarios y Empresas',
    emoji: '🤝',
    legal: true,
    description: 'Pagarés, donaciones, testamentos, empresas. Precios según complejidad S/E/A.',
    items: [
      { name: 'Comodato (uso)', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Pagaré notarial — S', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Pagaré notarial — E', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Pagaré notarial — A', modalidad: 'autentico', prices: { unico: 2000 } },
      { name: 'Partición amigable — E', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Partición amigable — A', modalidad: 'autentico', prices: { unico: 2500 } },
      { name: 'Donación entre vivos — E', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Donación entre vivos — A', modalidad: 'autentico', prices: { unico: 2500 } },
      { name: 'Determinación de herederos — E', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Determinación de herederos — A', modalidad: 'autentico', prices: { unico: 2500 } },
      { name: 'Testamento (bienes post mortem) — E', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Testamento (bienes post mortem) — A', modalidad: 'autentico', prices: { unico: 2500 } },
      { name: 'Divorcio mutuo consentimiento — E', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Divorcio mutuo consentimiento — A', modalidad: 'autentico', prices: { unico: 2000 } },
      { name: 'Matrimonio / estipulaciones', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Acto constitutivo (EIRL, SRL)', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Estatutos sociales', modalidad: 'autentico', prices: { unico: 1500 } },
      { name: 'Nómina de pagos/presencia', modalidad: 'autentico', prices: { unico: 500 } },
      { name: 'Contrato personalizado', modalidad: 'autentico', prices: { unico: 1500 } },
    ]
  },

  poderes: {
    name: 'Poderes y Autorizaciones',
    emoji: '📜',
    legal: true,
    description: 'Poderes notariales y autorizaciones legales según complejidad S/E/A.',
    items: [
      { name: 'Poder especial de autorización — S', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Poder especial de autorización — E', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Para depositar documentos', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Para realizar pagos o servicios', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Guarda y tutela de menor', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Viaje de menor', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Para venta de propiedades', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Cobrar suma de dinero', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Para procesos judiciales', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Ampliatorio', modalidad: 'autentico', prices: { unico: 800 } },
      { name: 'Poder cuota litis — S', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Poder cuota litis — E', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Poder cuota litis — A', modalidad: 'autentico', prices: { unico: 1500 } },
    ]
  },

  declaraciones: {
    name: 'Declaraciones Juradas',
    emoji: '✍️',
    legal: true,
    description: 'Declaraciones juradas notariales. Notarización según complejidad S/E/A.',
    items: [
      { name: 'Unión libre / soltería / domicilio — E', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Unión libre / soltería / domicilio — A', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'No convivencia', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Mejora const. (Estado dominicano)', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Mejora const. (particulares)', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Bienes e ingresos', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Portador de arma de fuego', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Pérdida de certificado de título', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Fabricación de trailers', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'De procedencia (lavado de activos)', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Responsabilidad (cambio nombre empresa)', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Pérdida de certificado financiero', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'De propiedad comercial', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'De conversión de moneda', modalidad: 'autentico', prices: { unico: 700 } },
    ]
  },

  notoriedades: {
    name: 'Notoriedades',
    emoji: '⚖️',
    legal: true,
    description: 'Actos de notoriedad notarial (E).',
    items: [
      { name: 'No convivencia (desvinculación de núcleo)', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Conocen al fallecido', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Buena conducta', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Buena conducta (empleado)', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Manutención parental', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'De no descendencia', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'De domicilio', modalidad: 'autentico', prices: { unico: 1000 } },
    ]
  },

  comprobaciones: {
    name: 'Comprobaciones',
    emoji: '🔍',
    legal: true,
    description: 'Verificación y autenticación de documentos',
    items: [
      { name: 'Comprobación de documentos', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Autenticidad de documentos', modalidad: 'autentico', prices: { unico: 1000 } },
      { name: 'Comprobación de evento', modalidad: 'autentico', prices: { unico: 1000 } },
    ]
  },

  cartas: {
    name: 'Cartas y Documentos en Tamaño Carta',
    emoji: '📝',
    legal: true,
    description: 'Cartas, comunicaciones y documentos carta. Notarización según complejidad S/E/A.',
    items: [
      { name: 'Cartas o comunicaciones certificando firmas — S', modalidad: 'autentico', prices: { unico: 500 } },
      { name: 'Coletilla y notarizar documento Fiel y Conforme — E', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Formulario Sucesiones y Donaciones DGII — A', modalidad: 'autentico', prices: { unico: 700 } },
      { name: 'Contrato de poderes — S', modalidad: 'autentico', prices: { unico: 500 } },
      { name: 'Contrato de alquileres o renta inmueble — S', modalidad: 'autentico', prices: { unico: 500 } },
      { name: 'Carta de garantía (sin notarizar)', modalidad: 'carta_privada', prices: { unico: 150 } },
      { name: 'Carta de invitación (sin notarizar)', modalidad: 'carta_privada', prices: { unico: 150 } },
      { name: 'Carta de autorización (sin notarizar)', modalidad: 'carta_privada', prices: { unico: 150 } },
      { name: 'Carta de compañía notariada', modalidad: 'autentico', prices: { unico: 500 } },
      { name: 'Carta oficial con firma notarial', modalidad: 'autentico', prices: { unico: 500 } },
    ]
  },

  instancias: {
    name: 'Instancias y Solicitudes',
    emoji: '📄',
    legal: true,
    description: 'Solicitudes formales ante instituciones (JCE, DGII, Cancillería, Tribunales, etc.)',
    items: [
      // RD$150 — solicitudes básicas
      { name: 'Solicitud de documentos', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de certificaciones', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de levantamiento', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud depósito de documentos', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud arrendamiento inmueble', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud desglose de expediente', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud desglose de pago', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de corrección', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de autorización', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de fijación de audiencia', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de pronunciamiento', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de asignación de sala', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud inscripción nombre comercial', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de transferencia', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de prórroga de expediente', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud de construcción', modalidad: 'instancia', prices: { unico: 150 } },
      { name: 'Solicitud recogida de escombros', modalidad: 'instancia', prices: { unico: 150 } },
      // RD$200
      { name: 'Solicitud de oposición', modalidad: 'instancia', prices: { unico: 200 } },
      { name: 'Solicitud de avalúo de inmueble', modalidad: 'instancia', prices: { unico: 200 } },
      // RD$300
      { name: 'Solicitud depósito de inventario', modalidad: 'instancia', prices: { unico: 300 } },
      { name: 'Solicitud de subsanación de expediente', modalidad: 'instancia', prices: { unico: 300 } },
      // RD$500
      { name: 'Recurso de amparo', modalidad: 'instancia', prices: { unico: 500 } },
      { name: 'Recurso de reconsideración', modalidad: 'instancia', prices: { unico: 500 } },
      { name: 'Recurso de apelación', modalidad: 'instancia', prices: { unico: 500 } },
      { name: 'Comunicación / invitación importante', modalidad: 'instancia', prices: { unico: 500 } },
    ]
  },

  traduccion: {
    name: 'Traducción de Documentos',
    emoji: '🌐',
    legal: true,
    description: 'Traducción de documentos para uso en el extranjero o embajadas. Certificada por intérprete judicial. Generalmente acompaña el servicio de apostilla.',
    items: [
      {
        name: 'Traducción de documento',
        modalidad: 'traduccion',
        desc: 'Precio cotizado por documento/página/letra luego de revisar el original. Enviar en formato JPEG, PNG o PDF.',
        prices: { 'cotizar': 0 }
      },
    ]
  },

  apostilla: {
    name: 'Apostilla en Cancillería',
    emoji: '📋',
    legal: true,
    description: 'Apostilla de documentos para uso en el extranjero. Servicio INDEPENDIENTE de la elaboración.',
    items: [
      {
        name: 'Apostilla en Cancillería',
        modalidad: 'apostilla',
        desc: 'Por documento. Requisito: documento bien escaneado, sin tachaduras ni borraduras. Se debe indicar el país de destino.',
        prices: { 'por documento': 300 }
      },
    ]
  },

  servicios_digitales: {
    name: 'Servicios Digitales',
    emoji: '💻',
    legal: false,
    description: 'Gestiones digitales ante instituciones públicas y privadas',
    items: [
      { name: 'Formulario DS-160 (visa americana)', modalidad: 'digital', prices: { 'por persona': 2000 } },
      {
        name: 'Certificación de Estatus Jurídico de Inmueble',
        modalidad: 'digital',
        prices: { 'por inmueble': 500 },
        requisitos: [
          'Instancia de solicitud (firmada por el representante o propietario)',
          'Cédula de identidad del representante o propietario',
          'Impuesto de Ley',
          'Copia o imagen del Título de Propiedad',
        ],
        ventajas: 'Solicitándolo con nosotros lo tienes en menos días!!',
        seguimiento: true,   // flag: status inquiries require human digitador follow-up
        nota_seguimiento: 'El seguimiento del estado de esta certificación requiere intervención del digitador (llamar/verificar con la institución). El bot NO responde el estado — escala al equipo.',
      },
      { name: 'Solicitudes ante DGII / Tribunales / Poder Judicial', modalidad: 'digital', prices: { 'por unidad': 500 } },
      { name: 'Solicitud emisión/renovación pasaporte dominicano', modalidad: 'digital', prices: { 'por unidad': 500 } },
      { name: 'Pagos en línea', modalidad: 'digital', prices: { 'por unidad': 500 } },
      { name: 'Certificación buena costumbre / no antecedentes penales', modalidad: 'digital', prices: { 'por unidad': 250 } },
      { name: 'Formularios Dirección General de Migración', modalidad: 'digital', prices: { 'desde': 600, 'hasta': 800 } },
      { name: 'Formularios Dirección General de Aduanas', modalidad: 'digital', prices: { 'por unidad': 500 } },
    ]
  },

  // ═══════════════════════════════════════════════════════
  // OFFICE SERVICES
  // ═══════════════════════════════════════════════════════

  impresiones: {
    name: 'Impresiones y Copias',
    emoji: '🖨️',
    legal: false,
    description: 'Documentos en formatos JPEG, PNG o PDF. Tamaños disponibles: 8½x11, 8½x14, 11x17',
    items: [
      // Copias
      { name: 'Copia 8½x11"', modalidad: 'copia', prices: { unidad: 3 } },
      { name: 'Copia 8½x14" (legal)', modalidad: 'copia', prices: { unidad: 10 } },
      { name: 'Copia 11x17"', modalidad: 'copia', prices: { unidad: 20 } },
      // Impresión B&N
      { name: 'Impresión B&N 8½x11"', modalidad: 'impresion_bn', prices: { unidad: 10 } },
      { name: 'Impresión B&N 8½x14" (legal)', modalidad: 'impresion_bn', prices: { unidad: 25 } },
      { name: 'Impresión B&N 11x17"', modalidad: 'impresion_bn', prices: { unidad: 50 } },
      // Impresión Color
      { name: 'Impresión color 8½x11"', modalidad: 'impresion_color', prices: { unidad: 20 } },
      { name: 'Impresión color 8½x14" (legal)', modalidad: 'impresion_color', prices: { unidad: 50 } },
      { name: 'Impresión color 11x17"', modalidad: 'impresion_color', prices: { unidad: 100 } },
    ]
  },

  mensajeria: {
    name: 'Mensajería',
    emoji: '🏍️',
    legal: false,
    description: 'Entrega de documentos',
    items: [
      { name: 'Mensajería local (Santo Domingo)', prices: { desde: 200 } },
    ]
  },

  tienda_fisica: {
    name: 'Tienda Física - Materiales de Oficina y Escolares',
    emoji: '🏪',
    legal: false,
    description: 'Papelería, útiles escolares y materiales de oficina',
    items: [
      // Paper products
      { name: 'Papel Bon 8.5" x 11" blanco', prices: { unidad: 2 } },
      { name: 'Papel Cartonite en blanco', prices: { unidad: 10 } },
      { name: 'Papel Adhesivo Satinado brillante', prices: { unidad: 20 } },
      { name: 'Papel Satinado grosor Slim brillante', prices: { unidad: 8 } },
      { name: 'Papel Vegetal', prices: { unidad: 10 } },
      { name: 'CD', prices: { unidad: 50 } },
      // Folders & envelopes
      { name: 'Folder Manila', prices: { unidad: 10 } },
      { name: 'Sobre Manila', prices: { unidad: 10 } },
      { name: 'Folder Multicolor Especial', prices: { unidad: 25 } },
      // Tools
      { name: 'Tijera Pequeña', prices: { unidad: 70 } },
      { name: 'Tijera Grande', prices: { unidad: 170 } },
      { name: 'Liquid Paper Tipo brocha', prices: { unidad: 100 } },
      { name: 'Liquid Paper Tipo Lápiz', prices: { unidad: 100 } },
      { name: 'Sacapuntas', prices: { desde: 25, hasta: 50 } },
      // Writing instruments
      { name: 'Lápiz Hbo 2', prices: { unidad: 15 } },
      { name: 'Bolígrafo Azul, Negro, Rojo, Verde', prices: { desde: 20, hasta: 50 } },
      // Folders & organizers
      { name: 'Carpeta Plástica', prices: { unidad: 100 } },
      { name: 'Carpeta Plástica tipo archivo', prices: { unidad: 250 } },
      { name: 'Carpeta Multicolor Plástica Horizontal', prices: { unidad: 100 } },
      { name: 'Carpeta Multicolor Cartón duro', prices: { unidad: 125 } },
      { name: 'Carpeta para Hojas Perforadas Plástica', prices: { unidad: 250 } },
      // Accessories
      { name: 'Tabla Pisa papel de Plywood', prices: { unidad: 80 } },
      { name: 'Marcadores Pizarra', prices: { unidad: 100 } },
      { name: 'Resaltador económico multicolor', prices: { unidad: 85 } },
    ]
  },
};

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatPrice(item) {
  return Object.entries(item.prices)
    .map(([k, v]) => k === 'unico' ? `RD$${v}` : `${k}: RD$${v}`)
    .join(', ');
}

function formatModalidad(m) {
  if (m === 'bajo_firma') return 'Bajo firma privada';
  if (m === 'autentico') return 'Auténtico (notarial)';
  if (m === 'instancia') return 'Instancia';
  if (m === 'apostilla') return 'Apostilla';
  return m;
}

function formatCategory(key) {
  const cat = SERVICE_CATEGORIES[key];
  if (!cat) return '';
  let text = `${cat.emoji} *${cat.name}*\n`;
  if (cat.description) text += `_${cat.description}_\n\n`;

  const byModalidad = {};
  for (const item of cat.items) {
    const m = item.modalidad || 'otro';
    if (!byModalidad[m]) byModalidad[m] = [];
    byModalidad[m].push(item);
  }

  for (const [m, items] of Object.entries(byModalidad)) {
    if (Object.keys(byModalidad).length > 1) {
      text += `📌 _${formatModalidad(m)}:_\n`;
    }
    for (const item of items) {
      text += `  • ${item.name}: *${formatPrice(item)}*\n`;
    }
    text += '\n';
  }
  return text;
}

function formatAllCategories() {
  const legalKeys = Object.keys(SERVICE_CATEGORIES).filter(k => SERVICE_CATEGORIES[k].legal);
  const officeKeys = Object.keys(SERVICE_CATEGORIES).filter(k => !SERVICE_CATEGORIES[k].legal);

  let text = `⚖️ *Tarifario de Servicios — Gurú Soluciones*\n\n`;
  text += `Todos los precios en pesos dominicanos (RD$).\n\n`;
  text += `📜 *Servicios Legales:*\n`;

  legalKeys.forEach((key, i) => {
    text += `${i + 1}. ${SERVICE_CATEGORIES[key].emoji} ${SERVICE_CATEGORIES[key].name}\n`;
  });

  text += `\n🏪 *Servicios de Oficina:*\n`;
  officeKeys.forEach((key, i) => {
    text += `${legalKeys.length + i + 1}. ${SERVICE_CATEGORIES[key].emoji} ${SERVICE_CATEGORIES[key].name}\n`;
  });

  text += `\n0️⃣ Regresar al menú principal`;
  text += `\n\nSeleccione un número para ver los precios detallados.`;
  return text;
}

module.exports = { SERVICE_CATEGORIES, formatPrice, formatCategory, formatAllCategories };
