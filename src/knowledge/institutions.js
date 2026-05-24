// Dominican Republic Government Institutions & Useful Links

const INSTITUTIONS = {
  dgii: {
    name: 'Dirección General de Impuestos Internos (DGII)',
    description: 'Administración tributaria dominicana. Gestiona impuestos, traspasos de vehículos, transferencias inmobiliarias y declaraciones fiscales.',
    url: 'https://dgii.gov.do',
    keywords: ['dgii', 'impuesto', 'impuestos', 'fiscal', 'traspaso', 'transferencia', 'itbis', 'isr', 'declaracion fiscal'],
  },
  jce: {
    name: 'Junta Central Electoral (JCE)',
    description: 'Organismo encargado del registro civil, emisión de cédulas de identidad, actas de nacimiento, matrimonio y defunción.',
    url: 'https://jce.gob.do',
    keywords: ['jce', 'cedula', 'identidad', 'acta nacimiento', 'acta matrimonio', 'acta defuncion', 'registro civil', 'estado civil'],
  },
  catastro: {
    name: 'Dirección Nacional de Catastro',
    description: 'Levantamiento, registro y mantenimiento del catastro nacional. Información de parcelas y terrenos.',
    url: 'https://www.catastro.gob.do',
    keywords: ['catastro', 'parcela', 'terreno', 'deslinde', 'medicion', 'plano catastral'],
  },
  registro_inmobiliario: {
    name: 'Jurisdicción Inmobiliaria (Registro de Títulos)',
    description: 'Registro de derechos inmobiliarios, títulos de propiedad, transferencias y gravámenes sobre inmuebles.',
    url: 'https://ri.gob.do',
    keywords: ['registro inmobiliario', 'titulo', 'propiedad', 'inmueble', 'certificado de titulo', 'registro de titulos'],
  },
  pgr: {
    name: 'Procuraduría General de la República (PGR)',
    description: 'Ministerio Público. Encargada de la persecución penal, representación del Estado en materia penal y protección de derechos fundamentales.',
    url: 'https://pgr.gob.do',
    keywords: ['procuraduria', 'pgr', 'ministerio publico', 'fiscal', 'penal', 'denuncia penal'],
  },
  migracion: {
    name: 'Dirección General de Migración',
    description: 'Control migratorio, permisos de residencia, visas, extensión de estadía y trámites migratorios.',
    url: 'https://migracion.gob.do',
    keywords: ['migracion', 'visa', 'residencia', 'pasaporte', 'extranjero', 'permiso estadia', 'estatus migratorio'],
  },
  dgjp: {
    name: 'Dirección General de Jubilaciones y Pensiones (DGJP)',
    description: 'Administración de pensiones y jubilaciones del sector público dominicano.',
    url: 'https://www.dgjp.gob.do/servicios/consulta-tu-pension/',
    keywords: ['pension', 'jubilacion', 'retiro', 'dgjp'],
  },
  afp_popular: {
    name: 'AFP Popular',
    description: 'Administradora de Fondos de Pensiones. Gestión de cuentas individuales de capitalización.',
    url: 'https://www.afppopular.com.do',
    keywords: ['afp popular', 'fondo pension', 'afp'],
  },
  afp_reservas: {
    name: 'AFP Reservas',
    description: 'Administradora de Fondos de Pensiones del sector público.',
    url: 'https://www.afpreservas.com',
    keywords: ['afp reservas', 'pension reservas'],
  },
  map: {
    name: 'Ministerio de Administración Pública (MAP)',
    description: 'Regulación del servicio civil y la carrera administrativa. Consulta de instituciones públicas.',
    url: 'https://map.gob.do',
    keywords: ['map', 'administracion publica', 'servicio civil', 'empleo publico'],
  },
  tribunal_nna: {
    name: 'Tribunal de Niños, Niñas y Adolescentes',
    description: 'Sala Civil del Tribunal de NNA de Santo Domingo. Asuntos de familia que involucran menores.',
    url: 'https://poderjudicial.gob.do/sala/sala-civil-del-tribunal-de-ninos-ninas-y-adolescente-de-santo-domingo/',
    keywords: ['menor', 'ninos', 'adolescente', 'tribunal nna', 'custodia', 'guarda menor'],
  },
  senado: {
    name: 'Senado de la República Dominicana',
    description: 'Cámara alta del Congreso Nacional. Legislación y consulta de leyes aprobadas.',
    url: 'https://www.senadord.gob.do',
    keywords: ['senado', 'congreso', 'ley', 'legislacion'],
  },
  hacienda: {
    name: 'Ministerio de Hacienda',
    description: 'Política fiscal y administración financiera del Estado dominicano.',
    url: 'https://www.hacienda.gob.do',
    keywords: ['hacienda', 'presupuesto', 'finanzas publicas'],
  },
  bienes_nacionales: {
    name: 'Bienes Nacionales',
    description: 'Administración y gestión de los bienes del Estado dominicano.',
    url: 'https://www.bn.gob.do',
    keywords: ['bienes nacionales', 'terreno del estado', 'propiedad estatal'],
  },
  liga_municipal: {
    name: 'Liga Municipal Dominicana (LMD)',
    description: 'Organismo de coordinación y apoyo a los municipios dominicanos.',
    url: 'https://lmd.gob.do',
    keywords: ['liga municipal', 'municipio', 'ayuntamiento'],
  },
  adn: {
    name: 'Ayuntamiento del Distrito Nacional (ADN)',
    description: 'Gobierno local del Distrito Nacional. Registro civil, conservaduría de hipotecas.',
    url: 'https://adn.gob.do/registro-civil-y-conservaduria-de-hipotecas/',
    keywords: ['ayuntamiento', 'distrito nacional', 'conservaduria', 'hipoteca', 'registro civil adn'],
  },
  notariado: {
    name: 'Ley del Notariado (140-15)',
    description: 'Marco legal que regula la función notarial en República Dominicana.',
    url: 'https://poderjudicial.gob.do/wp-content/uploads/2021/06/LEY_ley_notariado.pdf',
    keywords: ['notario', 'notariado', 'ley 140', 'acto notarial', 'fe publica', 'legalizacion'],
  },
  edesur: {
    name: 'EDESUR (Empresa Distribuidora de Electricidad del Sur)',
    description: 'Distribuidora eléctrica del sur del país. Consultas de servicio eléctrico.',
    url: 'https://www.edesur.com.do',
    keywords: ['edesur', 'electricidad', 'luz', 'energia'],
  },
  lavado_activos: {
    name: 'Ley 155-17 sobre Lavado de Activos',
    description: 'Legislación contra el lavado de activos y el financiamiento del terrorismo en RD.',
    url: 'https://www.sb.gob.do/regulacion/compendio-de-leyes-y-reglamentos/ley-no-155-17-lavado-de-activos-y-el-financiamiento-del-terrorismo/',
    keywords: ['lavado', 'activos', 'financiamiento terrorismo', 'ley 155', 'compliance', 'cumplimiento'],
  },
};

module.exports = INSTITUTIONS;
