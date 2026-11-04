const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const pool = require('../db/pool');
const storage = require('../utils/storage');
const { isUploadedModel } = require('./templatesCatalog');
const { removeThumbnails } = require('./thumbnails');

// Documentos · Etiquetas: tagged copies of the models, with versions and the admin's approval.
// Status of a model: untagged (no version), pending (latest version not approved), approved.

const STATUS_SQL = `
  CASE WHEN lv.id IS NULL THEN 'untagged'
       WHEN lv.id = t.approved_tag_version_id THEN 'approved'
       ELSE 'pending' END`;

const LATEST_JOIN = `
  LEFT JOIN LATERAL (SELECT id, version_number FROM template_tag_versions
                     WHERE template_id = t.id ORDER BY version_number DESC LIMIT 1) lv ON TRUE`;

// Every active model with its status (for lists and the summary). Private models stay out unless
// asked for: with `requested`, the ones whose owner asked to publish them come too.
async function listStatuses({ requested = false } = {}) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.file_path, c.name AS category, ${STATUS_SQL} AS status,
            lv.version_number AS latest_version, t.approved_tag_version_id, t.is_private, t.publish_requested_at,
            CASE WHEN t.is_private THEN COALESCE(NULLIF(ou.name, ''), ou.username) END AS owner_name,
            (SELECT COUNT(*)::int FROM template_corrections tc WHERE tc.template_id = t.id AND tc.status = 'pending') AS pending_corrections
     FROM doc_templates t LEFT JOIN doc_categories c ON c.id = t.category_id LEFT JOIN users ou ON ou.id = t.created_by ${LATEST_JOIN}
     WHERE t.is_active = TRUE AND (t.is_private = FALSE OR ($1::boolean AND t.publish_requested_at IS NOT NULL))
     ORDER BY c.name NULLS LAST, t.name`,
    [requested]
  );
  return rows;
}

// The private models this user can see: an admin all of them, anyone else only their own. Never cached.
async function listPrivate(user) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.description, t.file_path, t.file_name, c.name AS category, ${STATUS_SQL} AS status,
            t.created_by, t.publish_requested_at, COALESCE(NULLIF(ou.name, ''), ou.username) AS owner_name
     FROM doc_templates t LEFT JOIN doc_categories c ON c.id = t.category_id LEFT JOIN users ou ON ou.id = t.created_by ${LATEST_JOIN}
     WHERE t.is_active = TRUE AND t.is_private AND ($1::boolean OR t.created_by = $2)
     ORDER BY t.name`,
    [user?.role === 'admin', user?.id ?? null]
  );
  return rows;
}

// What this user can do with this model: 'admin', 'owner' (a private model they uploaded),
// 'employee' (a model that is not private) or null (someone else's private model).
function accessFor(user, t) {
  if (!user || !t) return null;
  if (user.role === 'admin') return 'admin';
  if (!t.is_private) return 'employee';
  return t.created_by != null && t.created_by === user.id ? 'owner' : null;
}

const VERSION_SELECT = `
  SELECT v.id, v.template_id, v.version_number, v.file_path, v.tags, v.skipped, v.source, v.notes, v.created_at,
         v.approved_at, v.created_by, v.origin_document_id, COALESCE(NULLIF(cu.name, ''), cu.username) AS created_by_name,
         COALESCE(NULLIF(au.name, ''), au.username) AS approved_by_name,
         od.title AS origin_title, oc.name AS origin_client
  FROM template_tag_versions v
  LEFT JOIN users cu ON cu.id = v.created_by
  LEFT JOIN users au ON au.id = v.approved_by
  LEFT JOIN portfolio_documents od ON od.id = v.origin_document_id
  LEFT JOIN clients oc ON oc.id = od.client_id`;

const publicVersion = ({ file_path, ...v }) => v;
// Employees fill the approved text: not where it came from, nor skipped paragraphs or the values each
// tag replaced (a client's data may be there)
const employeeVersion = ({ file_path, skipped, origin_document_id, origin_title, origin_client, tags, ...v }) => ({
  ...v, tags: (tags || []).map(({ example, examples, ...tag }) => tag),
});

async function getVersion(id) {
  const { rows } = await pool.query(`${VERSION_SELECT} WHERE v.id = $1`, [Number(id)]);
  return rows[0] || null;
}

async function getTemplate(templateId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.file_path, t.is_active, t.approved_tag_version_id, t.is_private, t.created_by, t.publish_requested_at, c.name AS category
     FROM doc_templates t LEFT JOIN doc_categories c ON c.id = t.category_id WHERE t.id = $1`,
    [Number(templateId)]
  );
  return rows[0] || null;
}

// The model with its versions. Employees only get the approved version (null when there is none);
// the owner of a private model sees it as an admin does. Pass `user`; `admin` is for internal calls.
async function getModel(templateId, { admin, user } = {}) {
  const t = await getTemplate(templateId);
  if (!t || !t.is_active) return null;
  const access = accessFor(user || { role: admin ? 'admin' : 'employee' }, t);
  if (!access) return null;
  const { rows: versions } = await pool.query(`${VERSION_SELECT} WHERE v.template_id = $1 ORDER BY v.version_number DESC`, [t.id]);
  const approved = versions.find((v) => v.id === t.approved_tag_version_id) || null;
  const latest = versions[0] || null;
  const status = !latest ? 'untagged' : latest === approved ? 'approved' : 'pending';
  const base = {
    id: t.id, name: t.name, category: t.category, status,
    is_private: t.is_private === true, can_manage: access !== 'employee', can_publish: access === 'admin', publish_requested_at: t.publish_requested_at || null,
  };
  if (access === 'employee') {
    if (!approved) return null;
    return { ...base, status: 'approved', current: employeeVersion(approved), approved: employeeVersion(approved) };
  }
  // the corrections each version applied
  const { rows: applied } = await pool.query(
    `SELECT c.id, c.comment, c.resulting_version_id, COALESCE(NULLIF(u.name, ''), u.username) AS created_by_name
     FROM template_corrections c LEFT JOIN users u ON u.id = c.created_by
     WHERE c.template_id = $1 AND c.status = 'applied' ORDER BY c.id`,
    [t.id]
  );
  const withCorrections = (v) => ({
    ...publicVersion(v),
    corrections: applied.filter((c) => c.resulting_version_id === v.id).map(({ resulting_version_id, ...c }) => c),
  });
  return {
    ...base,
    current: latest && withCorrections(latest),
    approved: approved && withCorrections(approved),
    versions: versions.map(withCorrections),
  };
}

// ── Trash: a deleted model is inactive (hidden from every list, the website and the bot) and keeps
// its files and versions; the admin restores it. Only active models go to the trash.
async function trash(templateId, userId) {
  const { rows } = await pool.query(
    `UPDATE doc_templates SET is_active = FALSE, deleted_at = NOW(), deleted_by = $2
     WHERE id = $1 AND is_active = TRUE RETURNING id, name`,
    [Number(templateId), userId]
  );
  return rows[0] || null;
}

async function untrash(templateId) {
  const { rows } = await pool.query(
    `UPDATE doc_templates SET is_active = TRUE, deleted_at = NULL, deleted_by = NULL
     WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id, name`,
    [Number(templateId)]
  );
  return rows[0] || null;
}

async function listTrash() {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, c.name AS category, t.deleted_at, COALESCE(NULLIF(u.name, ''), u.username) AS deleted_by_name,
            (t.approved_tag_version_id IS NOT NULL) AS was_approved
     FROM doc_templates t LEFT JOIN doc_categories c ON c.id = t.category_id LEFT JOIN users u ON u.id = t.deleted_by
     WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC`
  );
  return rows;
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
async function createVersion({ templateId, localFile, tags, skipped = [], source, notes = null, userId, baseVersionId, originDocumentId = null }) {
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
      `INSERT INTO template_tag_versions (template_id, version_number, file_path, tags, skipped, source, notes, created_by, origin_document_id)
       VALUES ($1, (SELECT COALESCE(MAX(version_number), 0) + 1 FROM template_tag_versions WHERE template_id = $1),
               $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, version_number`,
      [templateId, stored, JSON.stringify(tags), JSON.stringify(skipped), source, notes ? String(notes).slice(0, 500) : null, userId, originDocumentId]
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
  const t = await getTemplate(v.template_id);
  // an uploaded Word may carry a real client's data: everyone gets the reviewed version, and the original is gone.
  // Before the publish, so a failed copy leaves the model unpublished.
  if (isUploadedModel(t?.file_path)) {
    const tmp = `${t.file_path}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.copyFileSync(v.file_path, tmp);
    fs.renameSync(tmp, t.file_path);
    fs.rmSync(storage.getFilePath('template_pdf', `${t.id}.pdf`), { force: true });
    removeThumbnails(t.id);
  }
  await pool.query('UPDATE template_tag_versions SET approved_by = $1, approved_at = NOW() WHERE id = $2', [adminId, v.id]);
  // one statement: a private model can never be published (the database refuses it)
  await pool.query('UPDATE doc_templates SET approved_tag_version_id = $1, is_private = FALSE, publish_requested_at = NULL WHERE id = $2', [v.id, v.template_id]);
  return { ...v, was_private: t?.is_private === true, owner_id: t?.created_by ?? null };
}

// Who saved the model's version from that client document (for the approval notice)
async function originAuthor(templateId, documentId) {
  const { rows } = await pool.query(
    `SELECT created_by FROM template_tag_versions WHERE template_id = $1 AND origin_document_id = $2 AND source = 'client'
     ORDER BY version_number LIMIT 1`,
    [templateId, documentId]
  );
  return rows[0]?.created_by || null;
}

const isWord = (filePath) => path.extname(filePath || '').toLowerCase() === '.docx';

module.exports = { trash, untrash, listTrash, listStatuses, listPrivate, accessFor, getModel, getVersion, getTemplate, latestVersionId, createVersion, approve, originAuthor, isWord, StaleError };
