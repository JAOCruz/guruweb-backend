const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { authenticate, requireRole } = require('../middleware/auth');
const storage = require('../utils/storage');
const Client = require('../models/Client');
const { logActivity, safeLog } = require('../services/activityLog');
const { listModels, searchTemplates, resolveModelPath } = require('../documentos/templatesCatalog');
const { aiSearchTemplates } = require('../documentos/aiSearch');
const { convertToPdf } = require('../documentos/pdf');
const Portfolio = require('../documentos/portfolio');

// Documentos (Fase 1): "Buscar por nombre" in our selection of models + "Historial del digitador".
// Separate from MotherBrain: it only reads the models; tags are edited there.
const router = express.Router();
router.use(authenticate);

const MAX_BYTES = 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const sendError = (res, status, code, error) => res.status(status).json({ error, code });

// Word (.docx is a zip: "PK") or PDF ("%PDF"), checked by extension AND content
function checkFile(file) {
  if (!file) return null;
  const ext = path.extname(file.originalname || '').toLowerCase();
  const head = file.buffer.subarray(0, 4).toString('latin1');
  if (ext === '.docx' && head === 'PK\x03\x04') return DOCX;
  if (ext === '.pdf' && head === '%PDF') return 'application/pdf';
  return null;
}

function saveUpload(file, mime, notes) {
  const safe = path.basename(file.originalname).replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(-120);
  const stored = storage.saveBuffer(file.buffer, 'portfolio', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${safe}`);
  return { path: stored, name: safe, mime, size: file.size, notes: notes ? String(notes).slice(0, 500) : null };
}

// multer errors (too big) → friendly message
function withUpload(handler) {
  return (req, res) =>
    upload.single('file')(req, res, (err) => {
      if (err) {
        return err.code === 'LIMIT_FILE_SIZE'
          ? sendError(res, 400, 'FILE_TOO_LARGE', 'El archivo pasa de 20 MB')
          : sendError(res, 400, 'INVALID_FILE', 'No se pudo leer el archivo');
      }
      return handler(req, res);
    });
}

function sendFile(res, filePath, downloadName, inline) {
  res.attachment(downloadName);
  if (inline) res.setHeader('Content-Disposition', res.getHeader('Content-Disposition').replace(/^attachment/, 'inline'));
  res.sendFile(path.resolve(filePath));
}

function pdfError(res, err) {
  if (err.code === 'PDF_UNAVAILABLE') {
    return sendError(res, 503, 'PDF_UNAVAILABLE', 'La conversión a PDF no está disponible ahora; descarga el Word');
  }
  console.error('[documentos] PDF error:', err.message);
  return sendError(res, 500, 'PDF_FAILED', 'No se pudo convertir a PDF');
}

// ── Nuestra selección ──
router.get('/models', async (req, res) => {
  try {
    const all = await listModels();
    const models = searchTemplates(all, req.query.q || '').map(({ file_path, ...m }) => m);
    res.json({ models });
  } catch (err) {
    console.error('[documentos] models error:', err);
    res.status(500).json({ error: 'No se pudieron cargar los modelos' });
  }
});

router.post('/models/ai-search', async (req, res) => {
  const query = String((req.body || {}).query || '').trim();
  if (query.length < 3) return sendError(res, 400, 'QUERY_TOO_SHORT', 'Describe un poco más lo que necesitas');
  try {
    const picks = await aiSearchTemplates(query, await listModels());
    res.json({ models: picks.map(({ file_path, ...m }) => m) });
  } catch (err) {
    console.error('[documentos] AI search error:', err.message);
    sendError(res, 502, 'AI_UNAVAILABLE', 'La IA no respondió; intenta de nuevo o busca por nombre');
  }
});

router.get('/models/:id/file', async (req, res) => {
  try {
    const model = (await listModels()).find((m) => m.id === Number(req.params.id));
    const file = model && resolveModelPath(model.file_path);
    if (!file || !fs.existsSync(file)) return sendError(res, 404, 'NOT_FOUND', 'Modelo no encontrado');
    const baseName = model.name.replace(/[\\/:*?"<>|]+/g, ' ').trim();
    if (req.query.format === 'pdf') {
      const cached = storage.getFilePath('template_pdf', `${model.id}.pdf`);
      if (!fs.existsSync(cached) || fs.statSync(cached).mtimeMs < fs.statSync(file).mtimeMs) await convertToPdf(file, cached);
      return sendFile(res, cached, `${baseName}.pdf`, req.query.inline === '1');
    }
    return sendFile(res, file, `${baseName}.docx`, false);
  } catch (err) {
    return pdfError(res, err);
  }
});

// ── Clientes ──
router.get('/clients', async (req, res) => {
  try {
    res.json({ clients: await Portfolio.listClients(req.user, req.query.q) });
  } catch (err) {
    console.error('[documentos] clients error:', err);
    res.status(500).json({ error: 'No se pudieron cargar los clientes' });
  }
});

router.get('/clients/search', async (req, res) => {
  try {
    res.json({ clients: await Portfolio.searchAllClients(req.query.q) });
  } catch (err) {
    console.error('[documentos] client search error:', err);
    res.status(500).json({ error: 'No se pudieron buscar los clientes' });
  }
});

router.post('/clients', async (req, res) => {
  const name = String((req.body || {}).name || '').trim();
  const phone = String((req.body || {}).phone || '').replace(/[^\d+]/g, '');
  if (!name || phone.length < 7) return sendError(res, 400, 'INVALID_CLIENT', 'Escribe el nombre y un teléfono válido');
  try {
    const client = await Client.create({ name, phone, userId: req.user.id, source: 'documentos' });
    res.status(201).json({ client: { id: client.id, name: client.name, phone: client.phone } });
  } catch (err) {
    if (err.code === '23505') return sendError(res, 409, 'PHONE_TAKEN', 'Ya existe un cliente con ese teléfono; búscalo en la lista');
    console.error('[documentos] create client error:', err);
    res.status(500).json({ error: 'No se pudo crear el cliente' });
  }
});

// ── Historial ──
router.get('/documents', async (req, res) => {
  try {
    const documents = await Portfolio.listDocuments(req.user, {
      clientId: req.query.client_id, sort: req.query.sort, createdBy: req.query.created_by,
    });
    res.json({ documents });
  } catch (err) {
    console.error('[documentos] list error:', err);
    res.status(500).json({ error: 'No se pudieron cargar los documentos' });
  }
});

router.get('/documents/:id', async (req, res) => {
  const document = await Portfolio.getDocument(req.user, req.params.id).catch(() => null);
  if (!document) return sendError(res, 404, 'NOT_FOUND', 'Documento no encontrado');
  res.json({ document });
});

router.post('/documents', withUpload(async (req, res) => {
  const mime = checkFile(req.file);
  if (!mime) return sendError(res, 400, 'INVALID_FILE', 'Sube un documento Word (.docx) o PDF');
  const title = String(req.body.title || '').trim().slice(0, 200);
  const clientId = Number(req.body.client_id);
  if (!title) return sendError(res, 400, 'TITLE_REQUIRED', 'Ponle un nombre al documento');
  try {
    const { rows } = await require('../db/pool').query('SELECT id, name FROM clients WHERE id = $1', [clientId]);
    if (!rows.length) return sendError(res, 400, 'INVALID_CLIENT', 'Elige un cliente');
    const id = await Portfolio.createDocument({
      clientId, title, userId: req.user.id, file: saveUpload(req.file, mime, req.body.notes),
      templateId: req.body.template_id ? Number(req.body.template_id) : null,
    });
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'documento.upload', entityType: 'documento', entityId: id,
      summary: `Subió «${title}» (v1) de ${rows[0].name || 'cliente'}`,
    }));
    res.status(201).json({ document: await Portfolio.getDocument(req.user, id) });
  } catch (err) {
    console.error('[documentos] upload error:', err);
    res.status(500).json({ error: 'No se pudo guardar el documento' });
  }
}));

router.post('/documents/:id/versions', withUpload(async (req, res) => {
  const doc = await Portfolio.getDocument(req.user, req.params.id).catch(() => null);
  if (!doc) return sendError(res, 404, 'NOT_FOUND', 'Documento no encontrado');
  const mime = checkFile(req.file);
  if (!mime) return sendError(res, 400, 'INVALID_FILE', 'Sube un documento Word (.docx) o PDF');
  try {
    const n = await Portfolio.addVersion(doc.id, req.user.id, saveUpload(req.file, mime, req.body.notes));
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'documento.version', entityType: 'documento', entityId: doc.id,
      summary: `Subió la versión v${n} de «${doc.title}» (${doc.client_name || 'cliente'})`,
    }));
    res.status(201).json({ document: await Portfolio.getDocument(req.user, doc.id) });
  } catch (err) {
    console.error('[documentos] version error:', err);
    res.status(500).json({ error: 'No se pudo guardar la versión' });
  }
}));

router.post('/documents/:id/approve', requireRole('admin'), async (req, res) => {
  const doc = await Portfolio.getDocument(req.user, req.params.id).catch(() => null);
  if (!doc) return sendError(res, 404, 'NOT_FOUND', 'Documento no encontrado');
  const n = await Portfolio.approve(doc.id, Number((req.body || {}).version_id), req.user.id);
  if (!n) return sendError(res, 400, 'INVALID_VERSION', 'Esa versión no es de este documento');
  await safeLog(() => logActivity(req, {
    category: 'documentos', action: 'documento.approve', entityType: 'documento', entityId: doc.id,
    summary: `Aprobó la versión v${n} de «${doc.title}» (${doc.client_name || 'cliente'})`,
  }));
  res.json({ document: await Portfolio.getDocument(req.user, doc.id) });
});

router.get('/versions/:id/file', async (req, res) => {
  const v = await Portfolio.getVersion(req.user, req.params.id).catch(() => null);
  if (!v || !fs.existsSync(v.file_path)) return sendError(res, 404, 'NOT_FOUND', 'Versión no encontrada');
  const base = `${v.title} v${v.version_number}`.replace(/[\\/:*?"<>|]+/g, ' ').trim();
  const inline = req.query.inline === '1';
  try {
    if (req.query.format === 'pdf') {
      let pdfPath = v.pdf_path;
      if (!pdfPath || !fs.existsSync(pdfPath)) {
        pdfPath = await convertToPdf(v.file_path, storage.getFilePath('portfolio_pdf', `${v.id}.pdf`));
        await Portfolio.setVersionPdf(v.id, pdfPath);
      }
      return sendFile(res, pdfPath, `${base}.pdf`, inline);
    }
    if (v.mime_type !== DOCX) return sendError(res, 400, 'NO_WORD', 'Esta versión se subió en PDF; no tiene Word');
    return sendFile(res, v.file_path, v.file_name, false);
  } catch (err) {
    return pdfError(res, err);
  }
});

module.exports = router;
