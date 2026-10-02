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
const os = require('os');
const pool = require('../db/pool');
const { listBlocks, hasTags, applyOps, fillTags } = require('../documentos/docxText');
const aiDocs = require('../documentos/aiDocs');
const LegalProfile = require('../documentos/legalProfile');
const Tags = require('../documentos/templateTags');

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
    // tag status (Etiquetas); before its migration runs the list still works, without status
    const status = new Map((await Tags.listStatuses().catch(() => [])).map((m) => [m.id, m.status]));
    const models = searchTemplates(all, req.query.q || '').map(({ file_path, ...m }) => ({ ...m, tag_status: status.get(m.id) || 'untagged' }));
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

// ── Fase 2 · Generación (personalizar un modelo o una versión del historial) ──

const attachments = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 5 } });
const ATTACH_OK = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf|audio\/(mpeg|mp3|mp4|m4a|x-m4a|aac|ogg|wav|x-wav|webm))$/;
const fieldsCache = new Map();

function humanize(key, group) {
  const base = group !== 'DOCUMENTO' && key.endsWith(`_${group}`) ? key.slice(0, -(group.length + 1)) : key;
  const text = base.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// A model from our selection, or a Word version from my history
async function resolveSource(user, { model_id, version_id }) {
  if (version_id) {
    const v = await Portfolio.getVersion(user, version_id).catch(() => null);
    if (!v || !fs.existsSync(v.file_path)) return { error: [404, 'NOT_FOUND', 'Versión no encontrada'] };
    if (v.mime_type !== DOCX) return { error: [400, 'NO_WORD', 'Solo se puede personalizar una versión en Word (.docx)'] };
    return { file: v.file_path, title: v.title, version: v, documentId: v.document_id };
  }
  const model = (await listModels()).find((m) => m.id === Number(model_id));
  // an approved tagged version (Etiquetas) is filled exactly, with its own tags
  const approved = model && (await Tags.getModel(model.id, { admin: false }).catch(() => null));
  const tagged = approved && (await Tags.getVersion(approved.approved.id));
  if (tagged && fs.existsSync(tagged.file_path)) return { file: tagged.file_path, title: model.name, model, tags: tagged.tags };
  const file = model && resolveModelPath(model.file_path);
  if (!file || !fs.existsSync(file)) return { error: [404, 'NOT_FOUND', 'Modelo no encontrado'] };
  return { file, title: model.name, model };
}

// Fields = the model's tags in the database; without tags, the AI proposes them from the text
async function fieldsFor(source) {
  if (source.tags) return source.tags.map(({ key, label, group }) => ({ key, label, group }));
  if (source.model) {
    const { rows } = await pool.query(
      `SELECT v.tag, v.is_rol_dynamic, v.rol_type FROM doc_template_variables tv
       JOIN doc_variables v ON v.id = tv.variable_id WHERE tv.template_id = $1 ORDER BY tv.sort_order, v.id`,
      [source.model.id]
    );
    if (rows.length) {
      const seen = new Set();
      return rows
        .map((r) => {
          const group = r.is_rol_dynamic && r.rol_type ? r.rol_type : 'DOCUMENTO';
          const key = r.is_rol_dynamic && r.rol_type ? r.tag.replace('[ROL]', r.rol_type) : r.tag;
          return { key, label: humanize(key, group), group };
        })
        .filter((f) => !seen.has(f.key) && seen.add(f.key));
    }
  }
  const cacheKey = source.version ? `v${source.version.id}` : `m${source.model.id}`;
  if (!fieldsCache.has(cacheKey)) {
    fieldsCache.set(cacheKey, await aiDocs.deriveFields(await listBlocks(source.file), source.title));
  }
  return fieldsCache.get(cacheKey);
}

const rolesOf = (fields) => [...new Set(fields.map((f) => f.group).filter((g) => g !== 'DOCUMENTO'))];
const tmpDocx = () => path.join(os.tmpdir(), `doc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.docx`);
const sourceError = (res, source) => sendError(res, ...source.error);
const aiError = (res, err, context) => {
  console.error(`[documentos] ${context}:`, err.message);
  return sendError(res, 502, 'AI_UNAVAILABLE', 'La IA no respondió; intenta de nuevo');
};

// Saves a generated Word as v1 of a new document, or as the next version of the one it came from
async function saveGenerated(req, source, { clientId, title, out, sourceKind, notes }) {
  const name = `${String(title).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'documento'}.docx`;
  const stored = storage.saveLocalFile(out, 'portfolio', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${name}`);
  fs.rm(out, { force: true }, () => {});
  const file = { path: stored, name, mime: DOCX, size: fs.statSync(stored).size, source: sourceKind, notes };
  if (source.version) {
    await Portfolio.addVersion(source.documentId, req.user.id, file);
    return source.documentId;
  }
  return Portfolio.createDocument({ clientId, title, templateId: source.model.id, userId: req.user.id, file });
}

async function clientFor(source, clientId) {
  if (source.version) {
    const { rows } = await pool.query('SELECT client_id FROM portfolio_documents WHERE id = $1', [source.documentId]);
    clientId = rows[0]?.client_id;
  }
  const { rows } = await pool.query('SELECT id, name FROM clients WHERE id = $1', [Number(clientId)]);
  return rows[0] || null;
}

router.get('/fields', async (req, res) => {
  try {
    const source = await resolveSource(req.user, req.query);
    if (source.error) return sourceError(res, source);
    const fields = await fieldsFor(source);
    const role = req.query.client_role || null;
    const prefill = req.query.client_id ? LegalProfile.prefill(fields, await LegalProfile.get(Number(req.query.client_id)), role) : {};
    res.json({ fields, roles: rolesOf(fields), exact: await hasTags(source.file), prefill });
  } catch (err) {
    return aiError(res, err, 'fields');
  }
});

router.get('/clients/:id/profile', async (req, res) => {
  res.json({ profile: await LegalProfile.get(Number(req.params.id)) });
});

router.post('/fill/extract', (req, res) =>
  attachments.array('files', 5)(req, res, async (err) => {
    if (err) return sendError(res, 400, 'INVALID_FILE', err.code === 'LIMIT_FILE_SIZE' ? 'Un adjunto pasa de 15 MB' : 'Máximo 5 adjuntos');
    const files = req.files || [];
    if (files.some((f) => !ATTACH_OK.test(f.mimetype))) return sendError(res, 400, 'INVALID_FILE', 'Adjunta fotos, PDF o audios');
    if (files.reduce((n, f) => n + f.size, 0) > 15 * 1024 * 1024) return sendError(res, 400, 'INVALID_FILE', 'Los adjuntos pasan de 15 MB en total');
    try {
      const source = await resolveSource(req.user, req.body);
      if (source.error) return sourceError(res, source);
      const fields = await fieldsFor(source);
      const known = req.body.client_id ? await LegalProfile.get(Number(req.body.client_id)) : {};
      res.json({ values: await aiDocs.extractValues({ fields, known, text: req.body.text || '', files }) });
    } catch (e) {
      return aiError(res, e, 'extract');
    }
  })
);

router.post('/fill/generate', async (req, res) => {
  const { values = {}, client_role: role = null } = req.body || {};
  try {
    const source = await resolveSource(req.user, req.body);
    if (source.error) return sourceError(res, source);
    const client = await clientFor(source, req.body.client_id);
    if (!client) return sendError(res, 400, 'INVALID_CLIENT', 'Elige un cliente');
    const title = String(req.body.title || source.title).trim().slice(0, 200);
    const fields = await fieldsFor(source);
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
    const out = tmpDocx();
    const exact = await hasTags(source.file);
    let changes = [];
    if (exact) {
      await fillTags(source.file, out, clean);
    } else {
      const blocks = await listBlocks(source.file);
      const ops = await aiDocs.planFill({ blocks, values: clean, title: source.title });
      if (!ops.length) return sendError(res, 422, 'NO_CHANGES', 'La IA no encontró dónde poner esos datos; revisa el formulario');
      await applyOps(source.file, out, ops);
      changes = aiDocs.describe(ops, blocks);
    }
    const id = await saveGenerated(req, source, {
      clientId: client.id, title, out, sourceKind: 'generated',
      notes: exact ? 'Llenado exacto por etiquetas' : 'Personalizado con IA',
    });
    await LegalProfile.merge(client.id, LegalProfile.updatesFrom(fields, clean, role), req.user.id);
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'documento.generate', entityType: 'documento', entityId: id,
      summary: `Personalizó «${title}» para ${client.name || 'cliente'}${exact ? '' : ' con IA'}`,
    }));
    res.status(201).json({ document: await Portfolio.getDocument(req.user, id), changes, exact });
  } catch (err) {
    return aiError(res, err, 'generate');
  }
});

router.post('/ai-edit', async (req, res) => {
  const instructions = String((req.body || {}).instructions || '').trim();
  if (instructions.length < 5) return sendError(res, 400, 'INSTRUCTIONS_REQUIRED', 'Describe el cambio que quieres');
  try {
    const source = await resolveSource(req.user, req.body);
    if (source.error) return sourceError(res, source);
    const client = await clientFor(source, req.body.client_id);
    if (!client) return sendError(res, 400, 'INVALID_CLIENT', 'Elige un cliente');
    const blocks = await listBlocks(source.file);
    const ops = await aiDocs.planEdits({ blocks, instructions, title: source.title });
    if (!ops.length) return sendError(res, 422, 'NO_CHANGES', 'La IA no encontró qué cambiar; describe el cambio con más detalle');
    const out = tmpDocx();
    await applyOps(source.file, out, ops);
    const title = String(req.body.title || `${source.title} (personalizado)`).trim().slice(0, 200);
    const id = await saveGenerated(req, source, { clientId: client.id, title, out, sourceKind: 'ai_edit', notes: instructions.slice(0, 500) });
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'documento.ai_edit', entityType: 'documento', entityId: id,
      summary: `Cambios con IA en «${source.version ? source.title : title}» (${client.name || 'cliente'})`,
      details: { instructions: instructions.slice(0, 500) },
    }));
    res.status(201).json({ document: await Portfolio.getDocument(req.user, id), changes: aiDocs.describe(ops, blocks) });
  } catch (err) {
    return aiError(res, err, 'ai-edit');
  }
});

module.exports = router;
