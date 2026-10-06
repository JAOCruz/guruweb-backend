const pool = require('../db/pool');
const { canApproveDocuments, digitadoresAprueban } = require('./permissions');

// Historial del digitador. Employees only reach documents they created; the admin reaches all.
// With the "digitadores aprueban" switch on, an employee also reaches the bot's drafts
// (prepared_by_bot) of the clients assigned to them. Every query must join clients as `c`.
const isAdmin = (user) => user.role === 'admin';
const SORTS = {
  recent: 'd.updated_at DESC',
  date: 'd.created_at DESC',
  name: 'LOWER(d.title) ASC',
};

async function scope(user, params) {
  if (isAdmin(user)) return 'TRUE';
  params.push(user.id);
  const me = `$${params.length}`;
  if (await digitadoresAprueban()) return `(d.created_by = ${me} OR (d.prepared_by_bot AND c.assigned_to = ${me}))`;
  return `d.created_by = ${me}`;
}

const DOC_SELECT = `
  SELECT d.id, d.title, d.client_id, c.name AS client_name, c.phone AS client_phone, d.template_id,
         d.created_by, COALESCE(NULLIF(u.name, ''), u.username) AS created_by_name,
         d.created_at, d.updated_at, d.approved_version_id,
         d.prepared_by_bot, d.invoice_id, d.send_mode, d.sent_at, d.send_error,
         (SELECT MAX(version_number) FROM portfolio_versions v WHERE v.document_id = d.id) AS latest_version,
         (SELECT version_number FROM portfolio_versions v WHERE v.id = d.approved_version_id) AS approved_version,
         (SELECT COUNT(*)::int FROM portfolio_versions v WHERE v.document_id = d.id) AS versions_count
  FROM portfolio_documents d
  JOIN clients c ON c.id = d.client_id
  LEFT JOIN users u ON u.id = d.created_by`;

async function listClients(user, q) {
  const params = [];
  let where = await scope(user, params);
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    where += ` AND (c.name ILIKE $${params.length} OR c.phone ILIKE $${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.phone, COUNT(d.id)::int AS documents, MAX(d.updated_at) AS last_activity
     FROM portfolio_documents d JOIN clients c ON c.id = d.client_id
     WHERE ${where}
     GROUP BY c.id ORDER BY MAX(d.updated_at) DESC LIMIT 200`,
    params
  );
  return rows;
}

// Any client, to pick who a new document belongs to
async function searchAllClients(q) {
  const params = [];
  let where = 'TRUE';
  if (q && q.trim()) {
    params.push(`%${q.trim()}%`);
    where = `(name ILIKE $1 OR phone ILIKE $1)`;
  }
  const { rows } = await pool.query(
    `SELECT id, name, phone FROM clients WHERE ${where} ORDER BY name NULLS LAST LIMIT 20`,
    params
  );
  return rows;
}

async function listDocuments(user, { clientId, sort, createdBy } = {}) {
  const params = [];
  let where = await scope(user, params);
  if (clientId) {
    params.push(Number(clientId));
    where += ` AND d.client_id = $${params.length}`;
  }
  if (createdBy && isAdmin(user)) {
    params.push(Number(createdBy));
    where += ` AND d.created_by = $${params.length}`;
  }
  const { rows } = await pool.query(`${DOC_SELECT} WHERE ${where} ORDER BY ${SORTS[sort] || SORTS.recent}`, params);
  return rows;
}

async function getDocument(user, id) {
  const params = [Number(id)];
  const where = `d.id = $1 AND ${await scope(user, params)}`;
  const { rows } = await pool.query(`${DOC_SELECT} WHERE ${where}`, params);
  const doc = rows[0];
  if (!doc) return null;
  doc.can_approve = await canApproveDocuments(user, doc);
  const { rows: versions } = await pool.query(
    `SELECT v.id, v.version_number, v.file_name, v.mime_type, v.size_bytes, v.source, v.notes, v.created_at,
            v.created_by, COALESCE(NULLIF(u.name, ''), u.username) AS created_by_name, v.approved_at
     FROM portfolio_versions v LEFT JOIN users u ON u.id = v.created_by
     WHERE v.document_id = $1 ORDER BY v.version_number DESC`,
    [doc.id]
  );
  doc.versions = versions.map((v) => ({ ...v, status: v.id === doc.approved_version_id ? 'approved' : 'draft' }));
  return doc;
}

// invoiceId / preparedByBot: the bot's drafts (fase 2); the panel leaves them at their defaults.
async function createDocument({ clientId, title, templateId = null, userId, file, invoiceId = null, preparedByBot = false }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO portfolio_documents (client_id, title, template_id, created_by, invoice_id, prepared_by_bot)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [clientId, title, templateId, userId, invoiceId, preparedByBot === true]
    );
    await insertVersion(client, rows[0].id, 1, userId, file);
    await client.query('COMMIT');
    return rows[0].id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function addVersion(documentId, userId, file) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM portfolio_documents WHERE id = $1 FOR UPDATE', [documentId]);
    const { rows } = await client.query(
      'SELECT COALESCE(MAX(version_number), 0) + 1 AS next FROM portfolio_versions WHERE document_id = $1',
      [documentId]
    );
    await insertVersion(client, documentId, rows[0].next, userId, file);
    await client.query('UPDATE portfolio_documents SET updated_at = NOW() WHERE id = $1', [documentId]);
    await client.query('COMMIT');
    return rows[0].next;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function insertVersion(client, documentId, number, userId, file) {
  return client.query(
    `INSERT INTO portfolio_versions (document_id, version_number, file_path, file_name, mime_type, size_bytes, pdf_path, source, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [documentId, number, file.path, file.name, file.mime, file.size, file.mime === 'application/pdf' ? file.path : null,
      file.source || 'upload', file.notes || null, userId]
  );
}

// Marks the version approved and, when given, records how the document goes out
// ('al_pagar' | 'ya' | 'manual'). Returns the version number, or null if the version is not this document's.
async function approve(documentId, versionId, userId, sendMode = null) {
  const { rows } = await pool.query(
    'SELECT version_number FROM portfolio_versions WHERE id = $1 AND document_id = $2',
    [versionId, documentId]
  );
  if (!rows.length) return null;
  await pool.query('UPDATE portfolio_versions SET approved_by = $1, approved_at = NOW() WHERE id = $2', [userId, versionId]);
  await pool.query(
    'UPDATE portfolio_documents SET approved_version_id = $1, send_mode = COALESCE($3, send_mode), updated_at = NOW() WHERE id = $2',
    [versionId, documentId, sendMode]
  );
  return rows[0].version_number;
}

async function getVersion(user, versionId) {
  const params = [Number(versionId)];
  const { rows } = await pool.query(
    `SELECT v.*, d.title, d.created_by AS document_owner FROM portfolio_versions v
     JOIN portfolio_documents d ON d.id = v.document_id
     JOIN clients c ON c.id = d.client_id
     WHERE v.id = $1 AND ${await scope(user, params)}`,
    params
  );
  return rows[0] || null;
}

async function setVersionPdf(versionId, pdfPath) {
  await pool.query('UPDATE portfolio_versions SET pdf_path = $1 WHERE id = $2', [pdfPath, versionId]);
}

module.exports = {
  listClients, searchAllClients, listDocuments, getDocument, createDocument, addVersion, approve, getVersion, setVersionPdf,
};
