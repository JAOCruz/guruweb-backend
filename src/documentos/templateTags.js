const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const pool = require('../db/pool');
const storage = require('../utils/storage');

// Documentos · Etiquetas: tagged copies of the models, with versions and the admin's approval.
// Status of a model: untagged (no version), pending (latest version not approved), approved.

const STATUS_SQL = `
  CASE WHEN lv.id IS NULL THEN 'untagged'
       WHEN lv.id = t.approved_tag_version_id THEN 'approved'
       ELSE 'pending' END`;

const LATEST_JOIN = `
  LEFT JOIN LATERAL (SELECT id, version_number FROM template_tag_versions
                     WHERE template_id = t.id ORDER BY version_number DESC LIMIT 1) lv ON TRUE`;

// Every active model with its status (for lists and the summary)
async function listStatuses() {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.file_path, c.name AS category, ${STATUS_SQL} AS status,
            lv.version_number AS latest_version, t.approved_tag_version_id
     FROM doc_templates t LEFT JOIN doc_categories c ON c.id = t.category_id ${LATEST_JOIN}
     WHERE t.is_active = TRUE ORDER BY c.name NULLS LAST, t.name`
  );
  return rows;
}

const VERSION_SELECT = `
  SELECT v.id, v.template_id, v.version_number, v.file_path, v.tags, v.skipped, v.source, v.notes, v.created_at,
         v.approved_at, COALESCE(NULLIF(cu.name, ''), cu.username) AS created_by_name,
         COALESCE(NULLIF(au.name, ''), au.username) AS approved_by_name
  FROM template_tag_versions v
  LEFT JOIN users cu ON cu.id = v.created_by
  LEFT JOIN users au ON au.id = v.approved_by`;

const publicVersion = ({ file_path, ...v }) => v;

async function getVersion(id) {
  const { rows } = await pool.query(`${VERSION_SELECT} WHERE v.id = $1`, [Number(id)]);
  return rows[0] || null;
}

async function getTemplate(templateId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.file_path, t.is_active, t.approved_tag_version_id, c.name AS category
     FROM doc_templates t LEFT JOIN doc_categories c ON c.id = t.category_id WHERE t.id = $1`,
    [Number(templateId)]
  );
  return rows[0] || null;
}

// The model with its versions. Employees only get the approved version (null when there is none).
async function getModel(templateId, { admin }) {
  const t = await getTemplate(templateId);
  if (!t || !t.is_active) return null;
  const { rows: versions } = await pool.query(`${VERSION_SELECT} WHERE v.template_id = $1 ORDER BY v.version_number DESC`, [t.id]);
  const approved = versions.find((v) => v.id === t.approved_tag_version_id) || null;
  const latest = versions[0] || null;
  const status = !latest ? 'untagged' : latest === approved ? 'approved' : 'pending';
  const base = { id: t.id, name: t.name, category: t.category, status };
  if (!admin) {
    if (!approved) return null;
    return { ...base, status: 'approved', current: publicVersion(approved), approved: publicVersion(approved) };
  }
  return {
    ...base,
    current: latest && publicVersion(latest),
    approved: approved && publicVersion(approved),
    versions: versions.map(publicVersion),
  };
}

async function latestVersionId(templateId) {
  const { rows } = await pool.query(
    'SELECT id FROM template_tag_versions WHERE template_id = $1 ORDER BY version_number DESC LIMIT 1',
    [templateId]
  );
  return rows[0]?.id || null;
}

class StaleError extends Error {}

// Saves `localFile` (a tagged .docx) as the next version of the model. With `baseVersionId`, refuses
// (StaleError) when someone saved another version after that one.
async function createVersion({ templateId, localFile, tags, skipped = [], source, notes = null, userId, baseVersionId }) {
  const stored = storage.saveLocalFile(localFile, 'template_tags', `${templateId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.docx`);
  if (localFile !== stored && localFile.startsWith(require('os').tmpdir())) fs.rm(localFile, { force: true }, () => {});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM doc_templates WHERE id = $1 FOR UPDATE', [templateId]);
    if (baseVersionId !== undefined) {
      const { rows: latest } = await client.query(
        'SELECT id FROM template_tag_versions WHERE template_id = $1 ORDER BY version_number DESC LIMIT 1', [templateId]
      );
      if ((latest[0]?.id || null) !== baseVersionId) throw new StaleError('stale');
    }
    const { rows } = await client.query(
      `INSERT INTO template_tag_versions (template_id, version_number, file_path, tags, skipped, source, notes, created_by)
       VALUES ($1, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM template_tag_versions WHERE template_id = $1),
               $2, $3, $4, $5, $6, $7)
       RETURNING id, version_number`,
      [templateId, stored, JSON.stringify(tags), JSON.stringify(skipped), source, notes ? String(notes).slice(0, 500) : null, userId]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    fs.rm(stored, { force: true }, () => {});
    throw err;
  } finally {
    client.release();
  }
}

async function approve(versionId, adminId) {
  const v = await getVersion(versionId);
  if (!v) return null;
  await pool.query('UPDATE template_tag_versions SET approved_by = $1, approved_at = NOW() WHERE id = $2', [adminId, v.id]);
  await pool.query('UPDATE doc_templates SET approved_tag_version_id = $1 WHERE id = $2', [v.id, v.template_id]);
  return v;
}

const isWord = (filePath) => path.extname(filePath || '').toLowerCase() === '.docx';

module.exports = { listStatuses, getModel, getVersion, getTemplate, latestVersionId, createVersion, approve, isWord, StaleError };
