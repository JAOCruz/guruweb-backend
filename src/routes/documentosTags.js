const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { authenticate, requireRole } = require('../middleware/auth');
const pool = require('../db/pool');
const storage = require('../utils/storage');
const { logActivity, safeLog } = require('../services/activityLog');
const { resolveModelPath } = require('../documentos/templatesCatalog');
const { listBlocks, applySpans, fillTags, listTags } = require('../documentos/docxText');
const aiDocs = require('../documentos/aiDocs');
const Tags = require('../documentos/templateTags');
const Portfolio = require('../documentos/portfolio');
const LegalProfile = require('../documentos/legalProfile');
const { buildTagging, selectionSpan, normalizeKey, meta, EditError } = require('../documentos/tagging');

// Documentos · Etiquetas: AI tagging of the models, the admin's review (edits → new versions,
// approval) and exact filling of approved models. MotherBrain's tables are only read.
const router = express.Router();
router.use(authenticate);
const admin = requireRole('admin');
const isAdmin = (req) => req.user.role === 'admin';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BLANK = '________';
const sendError = (res, status, code, error, extra = {}) => res.status(status).json({ error, code, ...extra });
const tmpDocx = () => path.join(os.tmpdir(), `tags-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.docx`);

class TagError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    Object.assign(this, { status, code, extra });
  }
}

function originalFile(t) {
  const file = t && Tags.isWord(t.file_path) && resolveModelPath(t.file_path);
  return file && fs.existsSync(file) ? file : null;
}

// The model's MotherBrain tags, as vocabulary for the AI
async function vocabulary(templateId) {
  const { rows } = await pool.query(
    `SELECT v.tag, v.is_rol_dynamic, v.rol_type FROM doc_template_variables tv
     JOIN doc_variables v ON v.id = tv.variable_id WHERE tv.template_id = $1 ORDER BY tv.sort_order, v.id`,
    [templateId]
  ).catch(() => ({ rows: [] }));
  return [...new Set(rows.map((r) => (r.is_rol_dynamic && r.rol_type ? r.tag.replace('[ROL]', r.rol_type) : r.tag)))];
}

// Tags in the order they first appear in the file; metadata from `known`, defaults for the rest
async function orderedTags(file, known) {
  const byKey = new Map(known.map((t) => [t.key, t]));
  return [...new Set(await listTags(file))].map((k) => byKey.get(k) || meta(k));
}

async function tagModel(templateId, userId) {
  const t = await Tags.getTemplate(templateId);
  const file = originalFile(t);
  if (!file) throw new TagError(404, 'NOT_FOUND', 'Este modelo no tiene un Word (.docx) para etiquetar');
  const blocks = await listBlocks(file);
  let answer;
  try {
    answer = await aiDocs.planTags({ blocks, title: t.name, vocabulary: await vocabulary(t.id) });
  } catch (err) {
    console.error('[etiquetas] AI error:', err.message);
    throw new TagError(502, 'AI_UNAVAILABLE', 'La IA no respondió; intenta de nuevo');
  }
  const { spans, tags, skipped } = buildTagging(blocks, answer);
  if (!spans.length) {
    throw new TagError(422, 'NOTHING_TAGGED', 'La IA no pudo etiquetar este modelo sin cambiar su texto; etiquétalo a mano', { skipped });
  }
  const out = tmpDocx();
  await applySpans(file, out, spans);
  return Tags.createVersion({
    templateId: t.id, localFile: out, tags: await orderedTags(out, tags), skipped, source: 'ai', userId,
    notes: skipped.length ? `${skipped.length} párrafo(s) sin etiquetar: revísalos` : null,
  });
}

const fail = (res, err, context) => {
  if (err instanceof TagError) return sendError(res, err.status, err.code, err.message, err.extra);
  if (err instanceof EditError) return sendError(res, 400, 'INVALID_EDIT', err.message);
  console.error(`[etiquetas] ${context}:`, err);
  return sendError(res, 500, 'SERVER_ERROR', 'No se pudo completar; intenta de nuevo');
};

// ── Batch: tag every untagged .docx model, one at a time (resumable: tagged ones are skipped) ──
const batch = { running: false, total: 0, done: 0, failed: [], current: null, started_at: null, finished_at: null };

async function runBatch(userId) {
  const todo = (await Tags.listStatuses()).filter((m) => m.status === 'untagged' && originalFile(m));
  Object.assign(batch, { running: true, total: todo.length, done: 0, failed: [], current: null, started_at: new Date(), finished_at: null });
  for (const m of todo) {
    batch.current = m.name;
    try {
      await tagModel(m.id, userId);
    } catch (err) {
      batch.failed.push({ id: m.id, name: m.name, error: err.message });
    }
    batch.done += 1;
  }
  Object.assign(batch, { running: false, current: null, finished_at: new Date() });
}

router.get('/summary', admin, async (req, res) => {
  try {
    const all = await Tags.listStatuses();
    const counts = { untagged: 0, pending: 0, approved: 0 };
    for (const m of all) counts[m.status] += 1;
    const models = all.map(({ file_path, ...m }) => ({ ...m, taggable: Boolean(originalFile({ file_path })) }));
    res.json({ counts, models, batch });
  } catch (err) {
    return fail(res, err, 'summary');
  }
});

router.post('/batch', admin, (req, res) => {
  if (!batch.running) {
    runBatch(req.user.id).catch((err) => {
      console.error('[etiquetas] batch error:', err);
      Object.assign(batch, { running: false, current: null, finished_at: new Date() });
    });
    safeLog(() => logActivity(req, { category: 'documentos', action: 'etiquetas.batch', summary: 'Inició el etiquetado con IA de los modelos sin etiquetar' }));
  }
  res.status(202).json({ batch });
});

router.get('/batch', admin, (req, res) => res.json({ batch }));

router.post('/models/:id/ai', admin, async (req, res) => {
  try {
    const v = await tagModel(Number(req.params.id), req.user.id);
    const model = await Tags.getModel(req.params.id, { admin: true });
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'etiquetas.ai', entityType: 'modelo', entityId: model.id,
      summary: `Etiquetó con IA «${model.name}» (v${v.version_number})`,
    }));
    res.status(201).json({ model });
  } catch (err) {
    return fail(res, err, 'ai');
  }
});

router.get('/models/:id', async (req, res) => {
  try {
    const model = await Tags.getModel(req.params.id, { admin: isAdmin(req) });
    if (!model) return sendError(res, 404, 'NOT_FOUND', 'Este modelo todavía no está aprobado para llenar');
    res.json({ model });
  } catch (err) {
    return fail(res, err, 'model');
  }
});

router.get('/versions/:id/file', async (req, res) => {
  try {
    const v = await Tags.getVersion(req.params.id);
    const t = v && (await Tags.getTemplate(v.template_id));
    const allowed = v && t && (isAdmin(req) || (t.is_active && t.approved_tag_version_id === v.id));
    if (!allowed || !fs.existsSync(v.file_path)) return sendError(res, 404, 'NOT_FOUND', 'Versión no encontrada');
    res.attachment(`${t.name.replace(/[\\/:*?"<>|]+/g, ' ').trim()} (etiquetas v${v.version_number}).docx`);
    res.sendFile(path.resolve(v.file_path));
  } catch (err) {
    return fail(res, err, 'file');
  }
});

// Edits on the latest version → a new pending version.
// Selections are tagged first (they point at the base text), then renames/removals, then labels.
router.post('/models/:id/edit', admin, async (req, res) => {
  const { base_version_id: baseId, ops = [], notes = null } = req.body || {};
  try {
    const templateId = Number(req.params.id);
    if (!Array.isArray(ops) || !ops.length) return sendError(res, 400, 'INVALID_EDIT', 'No hay cambios para guardar');
    const latest = await Tags.latestVersionId(templateId);
    if (!latest) return sendError(res, 404, 'NOT_FOUND', 'Este modelo no tiene etiquetas todavía');
    if (Number(baseId) !== latest) return sendError(res, 409, 'STALE', 'Alguien guardó otra versión mientras editabas; recarga');
    const base = await Tags.getVersion(latest);
    const tags = base.tags.map((t) => ({ ...t }));
    const find = (key) => tags.find((t) => t.key === key);

    const blocks = await listBlocks(base.file_path);
    const spans = [];
    const replace = {};
    for (const op of ops) {
      if (op.op === 'tag') {
        const key = normalizeKey(op.key);
        if (!key) throw new EditError('Ponle un nombre a la etiqueta');
        const s = selectionSpan(blocks, op);
        spans.push({ i: s.i, start: s.start, end: s.end, text: `{{${key}}}` });
        if (!find(key)) tags.push(meta(key, op, s.value));
      } else if (op.op === 'rename') {
        const t = find(op.from);
        const key = normalizeKey(op.key);
        if (!t || !key) throw new EditError('Esa etiqueta no existe');
        if (key !== t.key) replace[t.key] = `{{${key}}}`;
        Object.assign(t, { key, ...(op.label ? { label: String(op.label).slice(0, 80) } : {}), ...(op.group ? { group: meta(key, op).group } : {}) });
      } else if (op.op === 'untag') {
        const t = find(op.key);
        if (!t) throw new EditError('Esa etiqueta no existe');
        replace[t.key] = t.example || BLANK;
        tags.splice(tags.indexOf(t), 1);
      } else if (op.op === 'meta') {
        const t = find(op.key);
        if (!t) throw new EditError('Esa etiqueta no existe');
        if (op.label) t.label = String(op.label).trim().slice(0, 80);
        if (op.group) t.group = meta(t.key, op).group;
      } else {
        throw new EditError('Cambio no reconocido');
      }
    }

    let file = base.file_path;
    if (spans.length) {
      const out = tmpDocx();
      await applySpans(file, out, spans);
      file = out;
    }
    if (Object.keys(replace).length) {
      const out = tmpDocx();
      await fillTags(file, out, replace);
      if (file !== base.file_path) fs.rm(file, { force: true }, () => {});
      file = out;
    }
    if (file === base.file_path) {
      file = tmpDocx();
      fs.copyFileSync(base.file_path, file);
    }
    const v = await Tags.createVersion({
      templateId, localFile: file, tags: await orderedTags(file, tags), skipped: base.skipped, source: 'edit', notes, userId: req.user.id,
    });
    const model = await Tags.getModel(templateId, { admin: true });
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'etiquetas.edit', entityType: 'modelo', entityId: templateId,
      summary: `Guardó la versión v${v.version_number} de las etiquetas de «${model.name}»`,
    }));
    res.status(201).json({ model });
  } catch (err) {
    return fail(res, err, 'edit');
  }
});

router.post('/models/:id/restore', admin, async (req, res) => {
  try {
    const templateId = Number(req.params.id);
    const old = await Tags.getVersion((req.body || {}).version_id);
    if (!old || old.template_id !== templateId) return sendError(res, 400, 'INVALID_VERSION', 'Esa versión no es de este modelo');
    const copy = tmpDocx();
    fs.copyFileSync(old.file_path, copy);
    const v = await Tags.createVersion({
      templateId, localFile: copy, tags: old.tags, skipped: old.skipped, source: 'restore',
      notes: `Restaurada desde v${old.version_number}`, userId: req.user.id,
    });
    const model = await Tags.getModel(templateId, { admin: true });
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'etiquetas.restore', entityType: 'modelo', entityId: templateId,
      summary: `Restauró la v${old.version_number} de «${model.name}» como v${v.version_number}`,
    }));
    res.status(201).json({ model });
  } catch (err) {
    return fail(res, err, 'restore');
  }
});

router.post('/versions/:id/approve', admin, async (req, res) => {
  try {
    const v = await Tags.approve(req.params.id, req.user.id);
    if (!v) return sendError(res, 404, 'NOT_FOUND', 'Versión no encontrada');
    const model = await Tags.getModel(v.template_id, { admin: true });
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'etiquetas.approve', entityType: 'modelo', entityId: v.template_id,
      summary: `Aprobó las etiquetas v${v.version_number} de «${model.name}»`,
    }));
    res.json({ model });
  } catch (err) {
    return fail(res, err, 'approve');
  }
});

// Exact filling: every tag gets its value or a blank line; the result goes to the client's history
router.post('/models/:id/fill', async (req, res) => {
  const { values = {}, client_role: role = null, version_id: versionId } = req.body || {};
  try {
    const model = await Tags.getModel(req.params.id, { admin: isAdmin(req) });
    if (!model || !model.current) return sendError(res, 404, 'NOT_FOUND', 'Este modelo todavía no está aprobado para llenar');
    const chosen = isAdmin(req) && versionId ? model.versions.find((v) => v.id === Number(versionId)) : model.approved || model.current;
    if (!chosen) return sendError(res, 400, 'INVALID_VERSION', 'Esa versión no es de este modelo');
    const clientId = Number(req.body.client_id);
    const { rows } = Number.isInteger(clientId) ? await pool.query('SELECT id, name FROM clients WHERE id = $1', [clientId]) : { rows: [] };
    const client = rows[0];
    if (!client) return sendError(res, 400, 'INVALID_CLIENT', 'Elige un cliente');

    const version = await Tags.getVersion(chosen.id);
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
    const keys = [...new Set(await listTags(version.file_path))];
    const filled = Object.fromEntries(keys.map((k) => [k, clean[k] || BLANK]));
    const out = tmpDocx();
    await fillTags(version.file_path, out, filled);

    const title = String(req.body.title || model.name).trim().slice(0, 200) || model.name;
    const name = `${title.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'documento'}.docx`;
    const stored = storage.saveLocalFile(out, 'portfolio', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${name}`);
    fs.rm(out, { force: true }, () => {});
    const id = await Portfolio.createDocument({
      clientId: client.id, title, templateId: model.id, userId: req.user.id,
      file: { path: stored, name, mime: DOCX, size: fs.statSync(stored).size, source: 'generated', notes: `Llenado por etiquetas (v${version.version_number})` },
    });
    await LegalProfile.merge(client.id, LegalProfile.updatesFrom(version.tags, clean, role), req.user.id);
    const empty = keys.filter((k) => !clean[k]).length;
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'documento.fill', entityType: 'documento', entityId: id,
      summary: `Llenó «${title}» para ${client.name || 'cliente'}${empty ? ` (${empty} etiqueta(s) en blanco)` : ''}`,
    }));
    res.status(201).json({ document: await Portfolio.getDocument(req.user, id), empty });
  } catch (err) {
    return fail(res, err, 'fill');
  }
});

module.exports = router;
module.exports.batch = batch;
