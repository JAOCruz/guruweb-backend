// Documentos · Gemini for personalizing documents. The model gets the document as numbered
// paragraphs and answers JSON; nothing is invented (unknown data stays as it is).
let generator = null;

// Tests inject a fake; `parts` is a string or an array of Gemini parts (text / inlineData)
function setGenerator(fn) {
  generator = fn;
}

async function defaultGenerate(parts) {
  const { model, fallbackModel } = require('../llm/client');
  try {
    return (await model.generateContent(parts)).response.text();
  } catch {
    return (await fallbackModel.generateContent(parts)).response.text();
  }
}

const ask = (parts) => (generator || defaultGenerate)(parts);

function parseJson(raw, open = '[', close = ']') {
  const s = String(raw).replace(/```(?:json)?/g, '');
  const a = s.indexOf(open);
  const b = s.lastIndexOf(close);
  if (a < 0 || b < a) throw new Error('La IA no devolvió un resultado válido');
  return JSON.parse(s.slice(a, b + 1));
}

const numbered = (blocks) =>
  blocks.filter((b) => b.text.trim()).map((b) => `[${b.i}] ${b.text}`).join('\n').slice(0, 60_000);

const CONTEXT = 'Trabajas en una oficina de servicios legales en República Dominicana (Gurú Soluciones).';

// Data a model needs, when the database has no tags for it
async function deriveFields(blocks, title) {
  const raw = await ask(`${CONTEXT}
Este es el modelo "${title}". Sus párrafos numerados:
${numbered(blocks)}

Lista los DATOS VARIABLES que cambian de un cliente a otro (nombres, cédulas, nacionalidad, estado civil, profesión, domicilios, fechas, montos, descripciones de bienes, números de acto, etc.). Agrúpalos por la persona o papel al que pertenecen (p. ej. VENDEDOR, COMPRADOR, REQUIRENTE) o "DOCUMENTO" para datos generales.
Responde SOLO JSON: [{"key": "NOMBRE_VENDEDOR", "label": "Nombre del vendedor", "group": "VENDEDOR"}]. Máximo 40 campos.`);
  return parseJson(raw)
    .filter((f) => f && f.key)
    .slice(0, 40)
    .map((f) => ({ key: String(f.key).toUpperCase().slice(0, 80), label: String(f.label || f.key).slice(0, 80), group: String(f.group || 'DOCUMENTO').toUpperCase().slice(0, 40) }));
}

// Tagging a model: the paragraphs with case data, rewritten with {{TAGS}} in place of that data
async function planTags({ blocks, title, vocabulary = [] }) {
  const raw = await ask(`${CONTEXT}
Vamos a convertir el modelo "${title}" en una plantilla con etiquetas. Contiene datos de un caso anterior (nombres, cédulas, nacionalidad, estado civil, profesión, domicilios, fechas, montos, matrículas, chasis, descripciones de bienes, números de acto) o espacios en blanco (____) donde van esos datos.
Sus párrafos numerados:
${numbered(blocks)}

Para cada párrafo que tenga esos datos, devuélvelo COMPLETO y EXACTAMENTE igual, cambiando solo cada dato (o espacio en blanco) por una etiqueta {{NOMBRE_DE_ETIQUETA}}. No cambies ni una letra, espacio o signo del resto del texto. Nunca pongas dos etiquetas seguidas sin texto entre ellas.
Nombres de etiqueta: MAYÚSCULAS, formato DATO_ROL (p. ej. NOMBRE_VENDEDOR, DOCUMENTO IDENTIDAD_COMPRADOR, NACIONALIDAD_VENDEDOR, DIRECCION O DOMICILIO_COMPRADOR); datos generales sin rol (CIUDAD_FIRMA, DIA_NUMERO, DIA_TEXTO, MES_TEXTO, AÑO_TEXTO, PRECIO_VENTA_LETRAS, PRECIO_VENTA_NUMEROS). Si el mismo dato de la misma persona se repite, usa la misma etiqueta. Montos y fechas escritos en letras y en números llevan etiquetas distintas (_LETRAS / _NUMEROS, _TEXTO / _NUMERO).
${vocabulary.length ? `Prefiere estas etiquetas que ya usa la oficina para este modelo: ${vocabulary.join(', ')}` : ''}
Responde SOLO JSON: {"paragraphs": [{"i": <número>, "text": "<párrafo con etiquetas>"}], "tags": [{"key": "NOMBRE_VENDEDOR", "label": "Nombre del vendedor", "group": "VENDEDOR"}]}
"group" es el papel de la persona (VENDEDOR, COMPRADOR, REQUIRENTE, TESTIGO 1…) o "DOCUMENTO" para datos generales.`);
  return parseJson(raw, '{', '}');
}

// Values for the form from the client's profile, attachments (photos, PDF, audio) and free text
async function extractValues({ fields, known = {}, text = '', files = [] }) {
  const list = fields.map((f) => `- ${f.key}: ${f.label}`).join('\n');
  const parts = [
    `${CONTEXT}
Extrae los datos para llenar un documento legal. Campos que se necesitan:
${list}

Datos ya conocidos del cliente (ficha): ${JSON.stringify(known)}
Información escrita por el digitador: ${String(text).slice(0, 5000) || '(ninguna)'}
${files.length ? `Se adjuntan ${files.length} archivo(s) (fotos de cédulas u otros documentos, PDF o audios): léelos/escúchalos.` : ''}

Reglas: usa solo información presente; no inventes. Nombres en MAYÚSCULAS como en los actos. Cédulas con formato 000-0000000-0.
Responde SOLO JSON con los campos que pudiste llenar: {"CAMPO": "valor"}`,
    ...files.map((f) => ({ inlineData: { mimeType: f.mimetype, data: f.buffer.toString('base64') } })),
  ];
  const values = parseJson(await ask(parts), '{', '}');
  const allowed = new Set(fields.map((f) => f.key));
  return Object.fromEntries(Object.entries(values).filter(([k, v]) => allowed.has(k) && v != null && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
}

// Where each value goes in a model without tags (replaces the previous case's data or blanks)
async function planFill({ blocks, values, title }) {
  const raw = await ask(`${CONTEXT}
Vamos a personalizar el documento "${title}". Sus párrafos numerados:
${numbered(blocks)}

Datos del nuevo caso: ${JSON.stringify(values)}

Reescribe SOLO los párrafos donde aparezcan datos de otro caso o espacios en blanco (____) que correspondan a estos datos, sustituyéndolos por los nuevos. Conserva todo lo demás del párrafo exactamente igual (redacción, mayúsculas, puntuación). No inventes datos que no estén en la lista; si falta un dato, deja ese fragmento como está.
Responde SOLO JSON: [{"i": <número de párrafo>, "text": "<párrafo completo reescrito>"}]`);
  return toReplaceOps(parseJson(raw), blocks);
}

// Specific changes asked in plain language
async function planEdits({ blocks, instructions, title }) {
  const raw = await ask(`${CONTEXT}
Documento "${title}". Sus párrafos numerados:
${numbered(blocks)}

Cambios que pide el digitador: ${String(instructions).slice(0, 3000)}

Aplica SOLO esos cambios con redacción legal dominicana y el mismo estilo del documento. Operaciones posibles:
- {"op": "replace", "i": n, "text": "<párrafo completo nuevo>"}
- {"op": "insert_after", "i": n, "text": "<párrafo nuevo>"}
- {"op": "delete", "i": n}
Responde SOLO JSON: [ ...operaciones ]`);
  const byI = new Map(blocks.map((b) => [b.i, b.text]));
  return parseJson(raw)
    .filter((o) => o && byI.has(Number(o.i)) && ['replace', 'insert_after', 'delete'].includes(o.op))
    .map((o) => ({ op: o.op, i: Number(o.i), text: o.op === 'delete' ? undefined : String(o.text || '') }))
    .filter((o) => !(o.op === 'replace' && o.text === byI.get(o.i)));
}

function toReplaceOps(items, blocks) {
  const byI = new Map(blocks.map((b) => [b.i, b.text]));
  return items
    .filter((o) => o && byI.has(Number(o.i)) && typeof o.text === 'string' && o.text !== byI.get(Number(o.i)))
    .map((o) => ({ op: 'replace', i: Number(o.i), text: o.text }));
}

// What changed, for the person to review
function describe(ops, blocks) {
  const byI = new Map(blocks.map((b) => [b.i, b.text]));
  return ops.map((o) => ({ op: o.op, i: o.i, before: o.op === 'insert_after' ? null : byI.get(o.i) ?? null, after: o.op === 'delete' ? null : o.text }));
}

module.exports = { setGenerator, planTags, deriveFields, extractValues, planFill, planEdits, describe };
