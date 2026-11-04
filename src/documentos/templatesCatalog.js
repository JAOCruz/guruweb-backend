const path = require('path');
const pool = require('../db/pool');
const storage = require('../utils/storage');

// "Nuestra selección": the curated, up-to-date models in doc_templates (with their own tags).
// Documentos only reads them; tags are managed in MotherBrain.

function templatesBaseDir() {
  return process.env.GURU_TEMPLATES_BASE_DIR || path.join(__dirname, '..', '..', 'templates', 'documents');
}

// Models people upload live on the persistent volume, not in the templates folder of the image
const UPLOADS_SUBDIR = 'template_uploads';
const uploadsDir = () => path.resolve(storage.getStorageRoot(), UPLOADS_SUBDIR);

// Absolute path of a model file, never outside the templates or uploads folder
function resolveModelPath(filePath) {
  const base = path.resolve(templatesBaseDir());
  const full = path.resolve(base, filePath || '');
  return full.startsWith(base + path.sep) || full.startsWith(uploadsDir() + path.sep) ? full : null;
}

// An uploaded model (not one of the library's own files)
const isUploadedModel = (filePath) => Boolean(filePath) && path.resolve(filePath).startsWith(uploadsDir() + path.sep);

let cache = { at: 0, list: null };
async function listModels() {
  if (cache.list && Date.now() - cache.at < 60_000) return cache.list;
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.file_path, t.file_name, c.name AS category
     FROM doc_templates t LEFT JOIN doc_categories c ON c.id = t.category_id
     WHERE t.is_active = TRUE AND t.is_private = FALSE
     ORDER BY c.name NULLS LAST, t.name`
  );
  cache = { at: Date.now(), list: rows };
  return rows;
}

// What this user can choose from: the shared models plus their private ones, first. An admin sees every private one.
async function listModelsFor(user) {
  const [mine, shared] = await Promise.all([require('./templateTags').listPrivate(user), listModels()]);
  return [...mine.map((m) => ({ ...m, is_private: true })), ...shared];
}

const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Every word must appear in the name or category (accent-insensitive); name matches rank first
function searchTemplates(list, q) {
  const words = norm(q).split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return list;
  const phrase = words.join(' ');
  return list
    .map((t) => {
      const name = norm(t.name);
      const hay = `${name} ${norm(t.category)}`;
      if (!words.every((w) => hay.includes(w))) return null;
      const score = (name.includes(phrase) ? 100 : 0) + words.filter((w) => name.includes(w)).length * 10 - name.length / 100;
      return { t, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.t);
}

// a model went to (or came back from) the trash: the next list reads the database
const clearCache = () => { cache = { at: 0, list: null }; };

module.exports = { UPLOADS_SUBDIR, isUploadedModel, clearCache, listModels, listModelsFor, searchTemplates, resolveModelPath, templatesBaseDir };
