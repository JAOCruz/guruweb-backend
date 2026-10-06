// Registro de herramientas del agente: definiciones para el modelo y ejecución con registro en bot_tool_log.
const pool = require('../../db/pool');
const { buscar_servicio, calcular_precio } = require('./catalog');
const { ver_tramite } = require('./tramites');
const { guardar_datos_cliente, leer_documento } = require('./client');
const { crear_solicitud, estado_solicitud } = require('./requests');
const { preparar_cotizacion } = require('./quote');
const { pasar_a_humano } = require('./handoff');
const { withTimeout } = require('../provider');

// Tope por herramienta (leer_documento llama al modelo de visión sin tope propio): pasado, { error } y ok=false.
const TOOL_TIMEOUT_MS = 20000;
let toolTimeoutOverride = null; // solo pruebas
function _setToolTimeoutMs(ms) { toolTimeoutOverride = typeof ms === 'number' && ms > 0 ? ms : null; }

// Los parámetros van en JSON Schema con tipos en minúsculas; cada adaptador los convierte a su formato.
const TOOLS = [
  {
    name: 'buscar_servicio',
    description: 'Busca en el catálogo de Gurú por nombre o por como lo pide la gente ("traspaso", "venta del carro", "poder", ' +
      '"declaración de soltería"). Úsela apenas el cliente mencione un documento, certificación o servicio, para saber si lo hacemos, ' +
      'su id, qué incluye, sus reglas, requisitos y si lleva notarización. Devuelve hasta 5 resultados; el precio que trae es solo ' +
      'de referencia: para decirle un monto al cliente use calcular_precio. Si depende_del_valor es true, el precio viene nulo: ' +
      'pregunte el valor del bien y páselo a calcular_precio.',
    parameters: {
      type: 'object',
      properties: {
        consulta: { type: 'string', description: 'Lo que el cliente pide, con sus palabras (p. ej. "acto de venta de un carro").' },
      },
      required: ['consulta'],
    },
  },
  {
    name: 'calcular_precio',
    description: 'Calcula el precio real de un servicio con el catálogo. Úsela antes de dar cualquier precio: nunca escriba un monto ' +
      'que no haya salido de esta herramienta. Si el servicio depende del valor del bien (actos de venta, traspasos), pregunte el valor ' +
      'primero y páselo en valor_del_bien; si devuelve falta: "valor_del_bien", pregúntelo y vuelva a llamar. Si devuelve ' +
      'por_confirmar o total nulo, diga "se lo confirmo" y cree la solicitud; si devuelve rango, dé el rango y diga que el ' +
      'digitador lo confirma.',
    parameters: {
      type: 'object',
      properties: {
        servicio_id: { type: 'integer', description: 'Id del servicio, tomado de buscar_servicio.' },
        valor_del_bien: { type: 'number', description: 'Valor del vehículo, inmueble u otro bien, cuando el precio depende de él.' },
        cantidad: { type: 'integer', description: 'Cuántas unidades (documentos, páginas, originales). Por defecto 1.' },
        con_notarizacion: { type: 'boolean', description: 'false si el cliente quiere solo la redacción, sin notarizar. Por defecto true.' },
      },
      required: ['servicio_id'],
    },
  },
  {
    name: 'ver_tramite',
    description: 'Trae los pasos, las preguntas obligatorias, las reglas y el total de un trámite completo (traspaso de vehículo, ' +
      'salida de menor, apostilla, etc.). Úsela cuando el cliente pida un proceso que combina varios servicios, antes de explicar ' +
      'el camino o cotizarlo, y haga al cliente cada pregunta obligatoria que devuelva.',
    parameters: {
      type: 'object',
      properties: {
        nombre: { type: 'string', description: 'Nombre o alias del trámite (p. ej. "traspaso de vehículo", "apostilla").' },
      },
      required: ['nombre'],
    },
  },
  {
    name: 'guardar_datos_cliente',
    description: 'Guarda en la ficha del cliente los datos que vaya dando en la conversación (nombre, cédula, nacionalidad, estado civil, ' +
      'profesión, dirección, correo). Úsela cada vez que el cliente dé un dato nuevo o corrija uno, sin pedirle un cuestionario. ' +
      'Nunca borra nada: si un dato cambia, guarda el nuevo y deja constancia del anterior. Los datos leídos de una foto se guardan ' +
      'solo después de que el cliente los confirme.',
    parameters: {
      type: 'object',
      properties: {
        campos: {
          type: 'object',
          description: 'Pares campo → valor. Use estos nombres cuando apliquen; otros campos también se aceptan.',
          properties: {
            nombre: { type: 'string', description: 'Nombre completo.' },
            cedula: { type: 'string', description: 'Cédula o pasaporte, tal como aparece en el documento.' },
            nacionalidad: { type: 'string', description: 'Nacionalidad.' },
            estado_civil: { type: 'string', description: 'Soltero/a, casado/a, unión libre, divorciado/a, viudo/a.' },
            profesion: { type: 'string', description: 'Profesión u ocupación.' },
            direccion: { type: 'string', description: 'Dirección o domicilio.' },
            email: { type: 'string', description: 'Correo electrónico.' },
            fecha_de_nacimiento: { type: 'string', description: 'Fecha de nacimiento.' },
          },
        },
      },
      required: ['campos'],
    },
  },
  {
    name: 'leer_documento',
    description: 'Extrae los datos de una foto o archivo que el cliente envió (cédula, pasaporte, matrícula, título). Úsela cuando ' +
      'llegue un documento con su id de medio y necesite los datos para la ficha o para un documento. Antes de guardar lo leído con ' +
      'guardar_datos_cliente, repítaselo al cliente y espere su confirmación.',
    parameters: {
      type: 'object',
      properties: {
        media_id: { type: 'integer', description: 'Id del medio, tal como aparece en el mensaje "[Foto/Documento enviado, id N]".' },
      },
      required: ['media_id'],
    },
  },
  {
    name: 'crear_solicitud',
    description: 'Crea la solicitud (caso) del cliente y avisa al digitador asignado o a los admins. Úsela cuando el cliente confirme ' +
      'que quiere seguir con un servicio, o cuando un precio quede por confirmar y haga falta que una persona lo revise. Ponga en ' +
      'detalles todo lo que ya sabe: servicio, valor del bien, cantidad, para cuándo lo necesita, si trae el documento o lo hacemos.',
    parameters: {
      type: 'object',
      properties: {
        servicio: { type: 'string', description: 'Nombre del servicio o trámite pedido, como está en el catálogo.' },
        detalles: { type: 'string', description: 'Resumen de lo acordado y los datos que faltan, para el digitador.' },
        servicio_id: { type: 'integer', description: 'Id del servicio del catálogo, si lo tiene.' },
      },
      required: ['servicio'],
    },
  },
  {
    name: 'preparar_cotizacion',
    description: 'Crea la cotización formal con los precios del catálogo; queda por aprobar por el admin, que la envía al cliente. ' +
      'Úsela solo después de que el cliente esté de acuerdo con el servicio y el precio calculado, y de tener los datos necesarios. ' +
      'No la use con servicios por confirmar; las partidas que dependen del valor del bien llevan valor_del_bien. Después de usarla, dígale al cliente que un miembro del equipo la revisa y se la ' +
      'confirma en horario de atención, sin prometer un tiempo.',
    parameters: {
      type: 'object',
      properties: {
        partidas: {
          type: 'array',
          description: 'Servicios a cotizar. Los precios no se mandan: se recalculan con el catálogo.',
          items: {
            type: 'object',
            properties: {
              servicio_id: { type: 'integer', description: 'Id del servicio del catálogo.' },
              cantidad: { type: 'integer', description: 'Unidades. Por defecto 1.' },
              valor_del_bien: { type: 'number', description: 'Valor del bien, si el precio depende de él.' },
              con_notarizacion: { type: 'boolean', description: 'false si va sin notarizar.' },
            },
            required: ['servicio_id'],
          },
        },
      },
      required: ['partidas'],
    },
  },
  {
    name: 'estado_solicitud',
    description: 'Consulta el estado de las solicitudes del cliente. Úsela cuando pregunte cómo va su caso, su certificación o escriba ' +
      '"ESTADO DE MI SOLICITUD". Responda con el estado que devuelve, sin prometer fechas que no estén ahí.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'pasar_a_humano',
    description: 'Pasa el chat a una persona del equipo: lo pone en modo manual, avisa al asignado o al admin y devuelve el mensaje de ' +
      'espera, que debe enviarse tal cual. Úsela con reclamaciones, pagos y comprobantes, reembolsos, asesoría legal, casos en tribunal, ' +
      'descuentos, cuando el cliente pida hablar con una persona, esté molesto, repita lo mismo, o con cualquier cosa que no pueda ' +
      'resolver con las demás herramientas.',
    parameters: {
      type: 'object',
      properties: {
        motivo: { type: 'string', description: 'Por qué se pasa, en pocas palabras, para quien lo atienda (p. ej. "reclamación por entrega").' },
      },
      required: ['motivo'],
    },
  },
];

const HANDLERS = {
  buscar_servicio, calcular_precio, ver_tramite, guardar_datos_cliente, leer_documento,
  crear_solicitud, estado_solicitud, preparar_cotizacion, pasar_a_humano,
};
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const isMissing = (v) => v === undefined || v === null || v === '';

async function runTool(name, args, ctx = {}) {
  const t0 = Date.now();
  const safeArgs = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const def = BY_NAME.get(name);
  let result;
  if (!def) {
    result = { error: `herramienta desconocida: ${name}` };
  } else {
    const faltan = (def.parameters.required || []).filter((k) => isMissing(safeArgs[k]));
    if (faltan.length) {
      result = { error: `faltan datos: ${faltan.join(', ')}` };
    } else {
      try {
        result = await withTimeout(Promise.resolve(HANDLERS[name](safeArgs, ctx)), toolTimeoutOverride || TOOL_TIMEOUT_MS);
        if (!result || typeof result !== 'object') result = { error: 'no se pudo completar' };
      } catch (err) {
        console.error(`[Agent] ${name} falló:`, err.code || err.name || 'error');
        result = { error: 'no se pudo completar' };
      }
    }
  }
  const ok = !Object.prototype.hasOwnProperty.call(result, 'error');
  const ms = Date.now() - t0;
  try {
    const { rows } = await pool.query(
      `INSERT INTO bot_tool_log (phone, herramienta, args, resultado, ok, ms) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [ctx.phone || '', String(name), JSON.stringify(safeArgs), JSON.stringify(result), ok, ms]);
    if (Array.isArray(ctx.toolLogIds)) ctx.toolLogIds.push(rows[0].id);
  } catch (err) {
    console.error('[Agent] no se pudo registrar la herramienta:', err.code || err.name || 'error');
  }
  console.log(`[Agent] ${ctx.phone || '?'} ${name} ok=${ok} ${ms}ms`);
  return result;
}

module.exports = { TOOLS, runTool, _setToolTimeoutMs };
