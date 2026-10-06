const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { authenticate, requireRole } = require('../middleware/auth');
const pool = require('../db/pool');
const { logActivity, safeLog } = require('../services/activityLog');
const { resolveModelPath } = require('../documentos/templatesCatalog');
const { listBlocks, applySpans, applyOps, fillTags, listTags } = require('../documentos/docxText');
const aiDocs = require('../documentos/aiDocs');
const Tags = require('../documentos/templateTags');
const Portfolio = require('../documentos/portfolio');
const { fillAndStore } = require('../documentos/fillDocument');
const LegalProfile = require('../documentos/legalProfile');
const multer = require('multer');
const { buildTagging, selectionSpan, normalizeKey, meta, EditError, TAG, tagsInText, cleanTagged, diffSpan } = require('../documentos/tagging');

// Documentos · Etiquetas: AI tagging of the models, the admin's review (edits → new versions,
// approval) and exact filling of approved models. MotherBrain's tables are only read.
const router = express.Router();
router.use(authenticate);
// ids are positive integers; anything else is simply not found
router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(404).json({ error: 'No encontrado', code: 'NOT_FOUND' })));
const admin = requireRole('admin');
const isAdmin = (req) => req.user.role === 'admin';

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
  try {
    await applySpans(file, out, spans);
    return await Tags.createVersion({
      templateId: t.id, localFile: out, tags: await orderedTags(out, tags), skipped, source: 'ai', userId,
      notes: skipped.length ? `${skipped.length} párrafo(s) sin etiquetar: revísalos` : null,
    });
  } finally {
    fs.rm(out, { force: true }, () => {});
  }
}

const fail = (res, err, context) => {
  if (err instanceof TagError) return sendError(res, err.status, err.code, err.message, err.extra);
  if (err instanceof EditError) return sendError(res, 400, 'INVALID_EDIT', err.message);
  if (err instanceof Tags.StaleError) return sendError(res, 409, 'STALE', 'Alguien guardó otra versión mientras editabas; recarga');
  console.error(`[etiquetas] ${context}:`, err);
  return sendError(res, 500, 'SERVER_ERROR', 'No se pudo completar; intenta de nuevo');
};

// Tags the models with those ids one at a time; a model that fails does not stop the rest.
// `tagger` is tagModel unless a test or script injects another one. Returns { done, failed }.
async function tagModels(ids, userId, { tagger = tagModel, onStart, onDone } = {}) {
  const failed = [];
  for (const id of ids) {
    if (onStart) onStart(id);
    let error = null;
    try {
      await tagger(id, userId);
    } catch (err) {
      error = err;
      failed.push({ id, error: err.message });
    }
    if (onDone) onDone(id, error);
  }
  return { done: ids.length, failed };
}

// ── Batch: tag every untagged .docx model, one at a time (resumable: tagged ones are skipped) ──
const batch = { running: false, total: 0, done: 0, failed: [], current: null, started_at: null, finished_at: null };

async function runBatch(userId) {
  const todo = (await Tags.listStatuses()).filter((m) => m.status === 'untagged' && originalFile(m));
  batch.total = todo.length;
  const nameOf = new Map(todo.map((m) => [m.id, m.name]));
  await tagModels(todo.map((m) => m.id), userId, {
    onStart: (id) => { batch.current = nameOf.get(id); },
    onDone: (id, err) => {
      if (err) batch.failed.push({ id, name: nameOf.get(id), error: err.message });
      batch.done += 1;
    },
  });
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
    // marked running right away, so a double click or a second admin cannot start another one
    Object.assign(batch, { running: true, total: 0, done: 0, failed: [], current: null, started_at: new Date(), finished_at: null });
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

// ── Body edits: the model's wording changes (a selection, a whole paragraph, paragraphs added or
// removed). They may add or remove tags; the tag list follows the new file. Kept apart from tag
// edits in one save, because both point at the text of the version on screen.
const BODY_OPS = new Set(['text', 'para', 'insert', 'delete']);

async function bodyEdit(base, ops, temps) {
  const blocks = await listBlocks(base.file_path);
  const byI = new Map(blocks.map((b) => [b.i, b]));
  const paragraph = (i, from) => {
    const b = byI.get(Number(i));
    if (!b || (from !== undefined && b.text !== from)) throw new EditError('Ese párrafo cambió o no existe; recarga e intenta de nuevo');
    return b;
  };
  const spans = [];
  const inserts = [];
  const deleted = new Set();
  for (const op of ops) {
    if (op.op === 'text') {
      const s = selectionSpan(blocks, op, { wholeTags: true });
      spans.push({ i: s.i, start: s.start, end: s.end, text: cleanTagged(op.replacement) });
    } else if (op.op === 'para') {
      const b = paragraph(op.i, op.from);
      const to = cleanTagged(op.to);
      if (to === b.text) continue;
      if (!b.text) inserts.push({ op: 'replace', i: b.i, text: to }); // an empty paragraph has nothing to keep
      else spans.push({ i: b.i, ...diffSpan(b.text, to) });
    } else if (op.op === 'insert') {
      paragraph(op.after);
      inserts.push({ op: 'insert_after', i: Number(op.after), text: cleanTagged(op.text) });
    } else if (op.op === 'delete') {
      deleted.add(paragraph(op.i, op.from).i);
    }
  }
  for (const s of spans) {
    if (deleted.has(s.i)) throw new EditError('Un párrafo que se borra también se cambia; quita uno de los dos cambios');
    if (spans.some((x) => x !== s && x.i === s.i && x.start < s.end && s.start < x.end)) throw new EditError('Dos cambios tocan el mismo texto');
  }

  // what the file must say afterwards; checked against the result (a Word field would block a change)
  const expected = [];
  for (const b of blocks) {
    let text = b.text;
    const replaced = inserts.find((o) => o.op === 'replace' && o.i === b.i);
    if (replaced) text = replaced.text;
    for (const s of spans.filter((x) => x.i === b.i).sort((x, y) => y.start - x.start)) text = text.slice(0, s.start) + s.text + text.slice(s.end);
    if (!deleted.has(b.i)) expected.push(text);
    for (const o of inserts) if (o.op === 'insert_after' && o.i === b.i) expected.push(o.text);
  }

  let file = base.file_path;
  if (spans.length) {
    temps.push(tmpDocx());
    await applySpans(file, temps.at(-1), spans);
    file = temps.at(-1);
  }
  const paraOps = [...inserts, ...[...deleted].map((i) => ({ op: 'delete', i }))];
  if (paraOps.length) {
    temps.push(tmpDocx());
    await applyOps(file, temps.at(-1), paraOps);
    file = temps.at(-1);
  }
  if (file === base.file_path) throw new EditError('No hay cambios para guardar');
  const got = (await listBlocks(file)).map((b) => b.text);
  if (JSON.stringify(got) !== JSON.stringify(expected)) {
    throw new EditError('Una parte de ese texto es un campo de Word (numeración, fecha automática…) y no se puede cambiar aquí; cámbiala en el Word');
  }

  // each tag keeps the original text of its places, in order; new tags start without one
  const known = base.tags.map((t) => ({ ...t, examples: Array.isArray(t.examples) ? t.examples : t.example != null ? [t.example] : [] }));
  const counts = {};
  for (const k of await listTags(file)) counts[k] = (counts[k] || 0) + 1;
  const tags = (await orderedTags(file, known)).map((t) => {
    const old = t.examples || [];
    const examples = Array.from({ length: counts[t.key] || 0 }, (_, n) => old[n] ?? old[0] ?? BLANK).filter((x) => x !== BLANK || old.length);
    return { ...t, examples, example: examples[0] ?? null };
  });
  return { file, tags };
}

// Edits on the latest version → a new pending version.
// Selections are tagged first (they point at the base text); then renames, removals and labels are
// applied to the tag list, and the file gets them in one pass. Each tag keeps the original text of
// each of its places (in document order), so removing a tag puts back exactly what was there.
router.post('/models/:id/edit', admin, async (req, res) => {
  const { base_version_id: baseId, ops = [], notes = null } = req.body || {};
  const temps = [];
  try {
    const templateId = Number(req.params.id);
    if (!Array.isArray(ops) || !ops.length) return sendError(res, 400, 'INVALID_EDIT', 'No hay cambios para guardar');
    const latest = await Tags.latestVersionId(templateId);
    if (!latest) return sendError(res, 404, 'NOT_FOUND', 'Este modelo no tiene etiquetas todavía');
    if (Number(baseId) !== latest) return sendError(res, 409, 'STALE', 'Alguien guardó otra versión mientras editabas; recarga');
    const base = await Tags.getVersion(latest);
    const body = ops.filter((o) => BODY_OPS.has(o && o.op));
    if (body.length && body.length !== ops.length) {
      throw new EditError('Guarda primero los cambios de etiquetas y después los cambios de texto (o al revés)');
    }
    if (body.length) {
      const { file, tags } = await bodyEdit(base, ops, temps);
      const v = await Tags.createVersion({
        templateId, localFile: file, tags, skipped: [], source: 'edit', notes, userId: req.user.id, baseVersionId: latest,
      });
      const model = await Tags.getModel(templateId, { admin: true });
      await safeLog(() => logActivity(req, {
        category: 'documentos', action: 'etiquetas.edit_text', entityType: 'modelo', entityId: templateId,
        summary: `Cambió el texto de «${model.name}» (v${v.version_number})${notes ? `: ${String(notes).slice(0, 120)}` : ''}`,
      }));
      return res.status(201).json({ model });
    }
    const examplesOf = (t) => (Array.isArray(t.examples) ? t.examples : t.example != null ? [t.example] : []);
    // fileKey: the name the tag has in the file; key: its name after these edits
    const tags = base.tags.map((t) => ({ ...t, fileKey: t.key, examples: examplesOf(t) }));
    const find = (key) => tags.find((t) => t.key === key);
    const removed = [];

    const blocks = await listBlocks(base.file_path);
    const spans = [];
    for (const op of ops) {
      if (op.op === 'tag') {
        const key = normalizeKey(op.key);
        if (!key) throw new EditError('Ponle un nombre a la etiqueta');
        const s = selectionSpan(blocks, op);
        if (spans.some((x) => x.i === s.i && x.start < s.end && s.start < x.end)) throw new EditError('Esa selección ya se etiquetó');
        spans.push({ i: s.i, start: s.start, end: s.end, text: `{{${key}}}`, key, value: s.value });
        if (!find(key)) tags.push({ ...meta(key, op, s.value), fileKey: key, examples: [] });
      } else if (op.op === 'rename') {
        const t = find(op.from);
        const key = normalizeKey(op.key);
        if (!t || !key) throw new EditError('Esa etiqueta no existe');
        if (key !== t.key && find(key)) throw new EditError(`Ya existe una etiqueta ${key}`);
        Object.assign(t, { key, ...(op.label ? { label: String(op.label).slice(0, 80) } : {}), ...(op.group ? { group: meta(key, op).group } : {}) });
      } else if (op.op === 'untag') {
        const t = find(op.key);
        if (!t) throw new EditError('Esa etiqueta no existe');
        tags.splice(tags.indexOf(t), 1);
        removed.push(t);
      } else if (op.op === 'meta') {
        const t = find(op.key);
        if (!t) throw new EditError('Esa etiqueta no existe');
        if (op.label) t.label = String(op.label).trim().slice(0, 80);
        if (op.group) t.group = meta(t.key, op).group;
      } else {
        throw new EditError('Cambio no reconocido');
      }
    }

    // original text of every place, in document order: existing places keep theirs, new ones bring the selection
    const byFileKey = new Map([...tags, ...removed].map((t) => [t.fileKey, t]));
    const places = [];
    for (const b of blocks) for (const m of b.text.matchAll(TAG)) places.push({ i: b.i, start: m.index, key: normalizeKey(m[1]) });
    for (const s of spans) places.push({ i: s.i, start: s.start, key: s.key, value: s.value });
    const blockOrder = new Map(blocks.map((b, n) => [b.i, n]));
    places.sort((x, y) => blockOrder.get(x.i) - blockOrder.get(y.i) || x.start - y.start);
    const seen = new Map();
    const examples = new Map();
    for (const p of places) {
      const n = seen.get(p.key) || 0;
      seen.set(p.key, n + 1);
      const old = byFileKey.get(p.key);
      const value = 'value' in p ? p.value : old?.examples[n] ?? old?.example ?? BLANK;
      examples.set(p.key, [...(examples.get(p.key) || []), value]);
    }
    for (const t of [...tags, ...removed]) t.examples = examples.get(t.fileKey) || t.examples;

    const replace = {};
    for (const t of tags) if (t.key !== t.fileKey) replace[t.fileKey] = `{{${t.key}}}`;
    for (const t of removed) replace[t.fileKey] = t.examples.length ? t.examples : BLANK;

    let file = base.file_path;
    if (spans.length) {
      temps.push(tmpDocx());
      await applySpans(file, temps.at(-1), spans);
      file = temps.at(-1);
    }
    if (Object.keys(replace).length) {
      temps.push(tmpDocx());
      await fillTags(file, temps.at(-1), replace);
      file = temps.at(-1);
    }
    if (file === base.file_path) {
      temps.push(tmpDocx());
      fs.copyFileSync(base.file_path, temps.at(-1));
      file = temps.at(-1);
    }
    const finalTags = tags.map(({ fileKey, ...t }) => ({ ...t, example: t.examples[0] ?? t.example ?? null }));
    const v = await Tags.createVersion({
      templateId, localFile: file, tags: await orderedTags(file, finalTags), skipped: base.skipped, source: 'edit', notes,
      userId: req.user.id, baseVersionId: latest,
    });
    const model = await Tags.getModel(templateId, { admin: true });
    await safeLog(() => logActivity(req, {
      category: 'documentos', action: 'etiquetas.edit', entityType: 'modelo', entityId: templateId,
      summary: `Guardó la versión v${v.version_number} de las etiquetas de «${model.name}»`,
    }));
    res.status(201).json({ model });
  } catch (err) {
    return fail(res, err, 'edit');
  } finally {
    for (const t of temps) fs.rm(t, { force: true }, () => {});
  }
});

// "Cambiar con IA": the AI proposes changes to the wording of the latest version; nothing is saved
// here. The admin confirms the ones they want and they come back through /edit as a new version.
router.post('/models/:id/ai-edit', admin, async (req, res) => {
  const instructions = String((req.body || {}).instructions || '').trim();
  if (instructions.length < 3) return sendError(res, 400, 'INVALID_EDIT', 'Escribe qué cambios legales quieres');
  try {
    const templateId = Number(req.params.id);
    const latest = await Tags.latestVersionId(templateId);
    if (!latest) return sendError(res, 404, 'NOT_FOUND', 'Este modelo no tiene etiquetas todavía');
    const [base, t] = await Promise.all([Tags.getVersion(latest), Tags.getTemplate(templateId)]);
    const blocks = await listBlocks(base.file_path);
    let ops;
    try {
      ops = await aiDocs.planEdits({ blocks, instructions, title: t.name, tagged: true });
    } catch (err) {
      console.error('[etiquetas] AI edit error:', err.message);
      return sendError(res, 502, 'AI_UNAVAILABLE', 'La IA no respondió; intenta de nuevo');
    }
    const byI = new Map(blocks.map((b) => [b.i, b.text]));
    const diff = (before, after) => {
      const a = new Set(tagsInText(before));
      const b = new Set(tagsInText(after));
      return { tags_added: [...b].filter((k) => !a.has(k)), tags_removed: [...a].filter((k) => !b.has(k)) };
    };
    const changes = [];
    for (const o of ops) {
      try {
        if (o.op === 'replace') {
          const to = cleanTagged(o.text);
          if (to !== byI.get(o.i)) changes.push({ op: 'para', i: o.i, from: byI.get(o.i), to, ...diff(byI.get(o.i), to) });
        } else if (o.op === 'insert_after') {
          const text = cleanTagged(o.text);
          if (text.trim()) changes.push({ op: 'insert', after: o.i, text, ...diff('', text) });
        } else if (o.op === 'delete') {
          changes.push({ op: 'delete', i: o.i, from: byI.get(o.i), ...diff(byI.get(o.i), '') });
        }
      } catch {
        // a change with a broken tag is left out
      }
    }
    res.json({ base_version_id: latest, changes });
  } catch (err) {
    return fail(res, err, 'ai-edit');
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

// "Llenar con IA": the AI reads photos, PDF, audio or text into the tags of the version on screen
const attachments = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 5 } });
const ATTACH_OK = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf|audio\/(mpeg|mp3|mp4|m4a|x-m4a|aac|ogg|wav|x-wav|webm))$/;

async function versionFor(req, model) {
  const asked = Number((req.body || {}).version_id);
  if (isAdmin(req) && asked) return model.versions.find((v) => v.id === asked) || null;
  return model.approved || model.current;
}

router.post('/models/:id/extract', (req, res) =>
  attachments.array('files', 5)(req, res, async (err) => {
    if (err) return sendError(res, 400, 'INVALID_FILE', err.code === 'LIMIT_FILE_SIZE' ? 'Un adjunto pasa de 15 MB' : 'Máximo 5 adjuntos');
    const files = req.files || [];
    if (files.some((f) => !ATTACH_OK.test(f.mimetype))) return sendError(res, 400, 'INVALID_FILE', 'Adjunta fotos, PDF o audios');
    try {
      const model = await Tags.getModel(req.params.id, { admin: isAdmin(req) });
      if (!model || !model.current) return sendError(res, 404, 'NOT_FOUND', 'Este modelo todavía no está aprobado para llenar');
      const version = await versionFor(req, model);
      if (!version) return sendError(res, 400, 'INVALID_VERSION', 'Esa versión no es de este modelo');
      const clientId = Number(req.body.client_id);
      const known = Number.isInteger(clientId) && clientId > 0 ? await LegalProfile.get(clientId) : {};
      const fields = version.tags.map(({ key, label, group }) => ({ key, label, group }));
      res.json({ values: await aiDocs.extractValues({ fields, known, text: req.body.text || '', files }) });
    } catch (e) {
      console.error('[etiquetas] extract:', e.message);
      return sendError(res, 502, 'AI_UNAVAILABLE', 'La IA no respondió; intenta de nuevo');
    }
  })
);

// Exact filling: every tag gets its value or a blank line; the result goes to the client's history
router.post('/models/:id/fill', async (req, res) => {
  const { values = {}, client_role: role = null } = req.body || {};
  try {
    const model = await Tags.getModel(req.params.id, { admin: isAdmin(req) });
    if (!model || !model.current) return sendError(res, 404, 'NOT_FOUND', 'Este modelo todavía no está aprobado para llenar');
    const chosen = await versionFor(req, model);
    if (!chosen) return sendError(res, 400, 'INVALID_VERSION', 'Esa versión no es de este modelo');
    const clientId = Number(req.body.client_id);
    const { rows } = Number.isInteger(clientId) ? await pool.query('SELECT id, name FROM clients WHERE id = $1', [clientId]) : { rows: [] };
    const client = rows[0];
    if (!client) return sendError(res, 400, 'INVALID_CLIENT', 'Elige un cliente');

    const version = await Tags.getVersion(chosen.id);
    const clean = Object.fromEntries(Object.entries(values).filter(([, v]) => v != null && String(v).trim()).map(([k, v]) => [k, String(v).trim()]));
    const keys = [...new Set(await listTags(version.file_path))];
    const filled = Object.fromEntries(keys.map((k) => [k, clean[k] || BLANK]));
    const title = String(req.body.title || model.name).trim().slice(0, 200) || model.name;
    const { id } = await fillAndStore({
      version, values: filled, title, clientId: client.id, templateId: model.id, userId: req.user.id,
      notes: `Llenado por etiquetas (v${version.version_number})`,
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
module.exports.tagModel = tagModel;
module.exports.tagModels = tagModels;
module.exports.originalFile = originalFile;
