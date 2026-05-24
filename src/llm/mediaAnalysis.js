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
async function analyzeDocument(filePath, mimeType, mediaType) {
  if (!canMakeRequest()) {
    console.log('[Media] Rate limited — skipping document analysis');
    return null;
  }

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

    recordRequest();

    const result = await generateWithFallback(async (m) => {
      return m.generateContent([
        { text: DOCUMENT_PROMPT },
        { inlineData: { data: fileData, mimeType: cleanMime } },
      ]);
    });

    if (!result) return null;
    const analysis = result.response.text().trim();

    if (!analysis || analysis.length < 5) {
      console.log('[Media] Empty document analysis');
      return null;
    }

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

module.exports = { transcribeAudio, analyzeDocument };
