const fs = require('fs');
const { canMakeRequest, recordRequest, generateWithFallback } = require('./generate');

const MAX_FILE_SIZE = 15 * 1024 * 1024; // 15MB — Gemini inline data safety margin

const TRANSCRIPTION_PROMPT = `Transcribe el siguiente audio en español. Es un mensaje de voz de WhatsApp de un cliente de un despacho jurídico en la República Dominicana.

Reglas:
- Transcribe EXACTAMENTE lo que dice la persona
- Si alguna parte no es clara, indica con [inaudible]
- No agregues interpretación ni comentarios — solo la transcripción literal
- Si es muy corto (ej: risa, suspiro), describe brevemente: [risa], [suspiro]
- Responde SOLO con la transcripción, nada más`;

const DOCUMENT_PROMPT = `Eres un clasificador de documentos para Gurú Soluciones, una oficina legal en República Dominicana.

Tu única tarea es DESCRIBIR y CLASIFICAR el documento. NO sugieras pasos. NO interpretes el contexto. NO asumas por qué el cliente lo envió.

Responde SIEMPRE en este formato exacto:

TIPO: [una de estas categorías exactas: CÉDULA, PASAPORTE, CONTRATO, NOTIFICACIÓN, ACTA, PODER_NOTARIAL, CERTIFICADO_TÍTULO, RECIBO, FACTURA, CARTA, FOTO_INMUEBLE, FOTO_VEHÍCULO, OTRO]
DATOS_VISIBLES: [lista los datos que puedas leer: nombres, números, fechas, montos, direcciones — solo lo visible]
EXTENSION: [cantidad de páginas visibles/estimadas y si el texto es simple o denso — ej: "1 página, texto simple" / "4 páginas, cláusulas densas"]
ESTADO: [LEGIBLE / BORROSO / INCOMPLETO / FIRMADO / SIN_FIRMAR]
NOTAS: [máximo una línea con algo técnico relevante, o "ninguna"]

Nada más. No respondas al cliente. No sugieras acciones. Solo clasifica.`;

/**
 * Transcribe a voice note using Gemini multimodal.
 * @param {string} filePath - Path to the audio file on disk
 * @param {string} mimeType - MIME type of the audio (e.g., 'audio/ogg; codecs=opus')
 * @returns {string|null} Transcription text or null on failure
 */
async function transcribeAudio(filePath, mimeType) {
  if (!canMakeRequest()) {
    console.log('[Media] Rate limited — skipping audio transcription');
    return null;
  }

  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      console.log(`[Media] Audio too large for analysis (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      return null;
    }

    const audioData = fs.readFileSync(filePath).toString('base64');
    recordRequest();

    const result = await generateWithFallback(async (m) => {
      return m.generateContent([
        { text: TRANSCRIPTION_PROMPT },
        { inlineData: { data: audioData, mimeType: mimeType.split(';')[0].trim() } },
      ]);
    });

    if (!result) return null;
    const transcription = result.response.text().trim();

    if (!transcription || transcription.length < 1) {
      console.log('[Media] Empty transcription');
      return null;
    }

    console.log(`[Media] Transcribed audio (${transcription.length} chars):\n${transcription}`);
    return transcription;
  } catch (err) {
    console.error('[Media] Audio transcription error:', err.message);
    return null;
  }
}

/**
 * Analyze an image or document (PDF, etc.) using Gemini multimodal.
 * @param {string} filePath - Path to the file on disk
 * @param {string} mimeType - MIME type of the file
 * @param {string} mediaType - 'image' or 'document'
 * @returns {string|null} Analysis text or null on failure
 */
// Fotos y PDF: los lee Claude (el mismo proveedor que contesta); Gemini queda de respaldo y para los demás archivos.
const CLAUDE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf']);
let claudeOverride = null; // solo pruebas
function _setClaudeClient(c) { claudeOverride = c || null; }
function claudeClient() {
  if (claudeOverride) return claudeOverride;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic();
}

// Devuelve el análisis o null (sin clave, error, negativa o respuesta vacía): entonces sigue Gemini.
async function analyzeWithClaude(fileData, mime) {
  if (!process.env.ANTHROPIC_API_KEY || !CLAUDE_MIMES.has(mime)) return null;
  const block = mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: mime, data: fileData } }
    : { type: 'image', source: { type: 'base64', media_type: mime, data: fileData } };
  try {
    const res = await claudeClient().messages.create({
      model: process.env.BOT_CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 4000,
      output_config: { effort: 'low' }, // solo clasificar y leer datos
      messages: [{ role: 'user', content: [block, { type: 'text', text: DOCUMENT_PROMPT }] }],
    }, { timeout: 60000, maxRetries: 1 });
    if (res.stop_reason === 'refusal') { console.log('[Media] Claude declined the document; trying Gemini'); return null; }
    const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    if (text.length < 5) { console.log('[Media] Claude returned an empty analysis; trying Gemini'); return null; }
    return text;
  } catch (err) {
    console.error('[Media] Claude document analysis failed; trying Gemini:', err.status || err.name || 'error');
    return null;
  }
}

async function analyzeDocument(filePath, mimeType, mediaType) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE) {
      console.log(`[Media] File too large for analysis (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
      return null;
    }

    const fileData = fs.readFileSync(filePath).toString('base64');

    // Normalize MIME type for Gemini (strip codec info)
    let cleanMime = mimeType.split(';')[0].trim();
    // Gemini needs specific MIME types for inline data
    if (cleanMime === 'application/octet-stream') {
      // Try to infer from file extension
      if (filePath.endsWith('.pdf')) cleanMime = 'application/pdf';
      else if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) cleanMime = 'image/jpeg';
      else if (filePath.endsWith('.png')) cleanMime = 'image/png';
    }

    if (cleanMime === 'image/jpg') cleanMime = 'image/jpeg';
    let analysis = await analyzeWithClaude(fileData, cleanMime);
    if (analysis) console.log(`[Media] Read by Claude (${mediaType})`);

    if (!analysis && !canMakeRequest()) {
      console.log('[Media] Rate limited — skipping document analysis');
      return null;
    }

    // A veces Gemini responde vacío a una foto legible: se intenta una vez más antes de rendirse
    // (sin análisis el bot le pide al cliente que mande la foto otra vez).
    for (let intento = 1; intento <= 2 && (!analysis || analysis.length < 5); intento++) {
      recordRequest();
      const result = await generateWithFallback(async (m) => {
        return m.generateContent([
          { text: DOCUMENT_PROMPT },
          { inlineData: { data: fileData, mimeType: cleanMime } },
        ]);
      });
      if (!result) return null;
      analysis = (result.response.text() || '').trim();
      if (!analysis || analysis.length < 5) {
        const reason = result.response.candidates?.[0]?.finishReason || 'desconocido';
        console.log(`[Media] Empty document analysis (intento ${intento}, motivo: ${reason})`);
      }
    }
    if (!analysis || analysis.length < 5) return null;

    // Cap analysis length for WhatsApp
    const capped = analysis.length > 2000
      ? analysis.substring(0, 2000) + '\n\n_[Análisis resumido]_'
      : analysis;

    console.log(`[Media] Analyzed ${mediaType} (${capped.length} chars): "${capped.substring(0, 80)}..."`);
    return capped;
  } catch (err) {
    console.error('[Media] Document analysis error:', err.message);
    return null;
  }
}

module.exports = { transcribeAudio, analyzeDocument, _setClaudeClient };
