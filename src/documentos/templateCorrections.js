const pool = require('../db/pool');

// Documentos · corrections: anyone reports what is wrong (or could be better) in a model; the admin
// applies it in a new version or dismisses it. Each one keeps who, when and the versions involved.

const NAME = (alias) => `COALESCE(NULLIF(${alias}.name, ''), ${alias}.username)`;

const SELECT = `
  SELECT c.id, c.template_id, c.version_id, c.paragraph_i, c.excerpt, c.comment, c.status, c.created_by, c.created_at,
         c.resolved_at, c.resolution_note, c.resulting_version_id,
         v.version_number, rv.version_number AS resulting_version_number,
         ${NAME('cu')} AS created_by_name, ${NAME('ru')} AS resolved_by_name
  FROM template_corrections c
  LEFT JOIN template_tag_versions v ON v.id = c.version_id
  LEFT JOIN template_tag_versions rv ON rv.id = c.resulting_version_id
  LEFT JOIN users cu ON cu.id = c.created_by
  LEFT JOIN users ru ON ru.id = c.resolved_by`;

async function create({ templateId, versionId, paragraphI = null, excerpt = null, comment, userId }) {
  const { rows } = await pool.query(
    `INSERT INTO template_corrections (template_id, version_id, paragraph_i, excerpt, comment, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [templateId, versionId, paragraphI, excerpt, comment, userId]
  );
  return get(rows[0].id);
}

async function get(id) {
  const { rows } = await pool.query(`${SELECT} WHERE c.id = $1`, [Number(id)]);
  return rows[0] || null;
}

// Newest first; with `userId`, only that person's reports
async function list(templateId, { userId } = {}) {
  const params = [Number(templateId)];
  if (userId) params.push(userId);
  const { rows } = await pool.query(
    `${SELECT} WHERE c.template_id = $1 ${userId ? 'AND c.created_by = $2' : ''} ORDER BY c.created_at DESC, c.id DESC`,
    params
  );
  return rows;
}

// Marks a pending correction applied or dismissed; null when it was not pending anymore
async function resolve(id, { status, userId, note = null, resultingVersionId = null }) {
  const { rows } = await pool.query(
    `UPDATE template_corrections
     SET status = $2, resolved_by = $3, resolved_at = NOW(), resolution_note = $4, resulting_version_id = $5
     WHERE id = $1 AND status = 'pending' RETURNING id`,
    [Number(id), status, userId, note, resultingVersionId]
  );
  return rows[0] ? get(rows[0].id) : null;
}

module.exports = { create, get, list, resolve };
