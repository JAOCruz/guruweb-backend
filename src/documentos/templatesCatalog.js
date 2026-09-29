const path = require('path');
const pool = require('../db/pool');

// "Nuestra selección": the curated, up-to-date models in doc_templates (with their own tags).
// Documentos only reads them; tags are managed in MotherBrain.

function templatesBaseDir() {
  return process.env.GURU_TEMPLATES_BASE_DIR || path.join(__dirname, '..', '..', 'templates', 'documents');
}

// Absolute path of a model file, never outside the templates folder
function resolveModelPath(filePath) {
  const base = path.resolve(templatesBaseDir());
  const full = path.resolve(base, filePath || '');
  return full.startsWith(base + path.sep) ? full : null;
}

let cache = { at: 0, list: null };
async function listModels() {
  if (cache.list && Date.now() - cache.at < 60_000) return cache.list;
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.file_path, t.file_name, c.name AS category
     FROM doc_templates t LEFT JOIN doc_categories c ON c.id = t.category_id
     WHERE t.is_active = TRUE
     ORDER BY c.name NULLS LAST, t.name`
  );
  cache = { at: Date.now(), list: rows };
  return rows;
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

module.exports = { listModels, searchTemplates, resolveModelPath, templatesBaseDir };
