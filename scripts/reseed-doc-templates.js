/**
 * Reseed doc_categories and doc_templates from document_index.json.
 * document_index.json has the correct file paths relative to templates/documents.
 */
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');

const INDEX_PATH = process.env.DOCUMENT_INDEX_PATH
  || path.join(__dirname, '..', '..', 'guru-whatsapp-bot', 'DB', 'document_index.json');

function slugify(str) {
  return str.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function ensureCategory(client, name, parentId = null) {
  const slug = slugify(name);
  const { rows } = await client.query(
    `SELECT id FROM doc_categories WHERE slug = $1 AND parent_id ${parentId ? '= $2' : 'IS NULL'}`,
    parentId ? [slug, parentId] : [slug]
  );
  if (rows.length) return rows[0].id;

  const { rows: inserted } = await client.query(
    `INSERT INTO doc_categories (name, slug, parent_id, sort_order)
     VALUES ($1, $2, $3, 0) RETURNING id`,
    [name, slug, parentId]
  );
  return inserted[0].id;
}

async function main() {
  if (!fs.existsSync(INDEX_PATH)) {
    throw new Error(`Document index not found at ${INDEX_PATH}`);
  }
  const index = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const docs = index.documents || [];
  console.log(`Found ${docs.length} documents in ${INDEX_PATH}`);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Deactivate all existing templates; matched ones will be re-activated
    await client.query('UPDATE doc_templates SET is_active = false');

    for (const doc of docs) {
      const categories = [doc.category, doc.subcategory, doc.sub_subcategory].filter(Boolean);
      let parentId = null;
      for (const catName of categories) {
        parentId = await ensureCategory(client, catName, parentId);
      }

      const name = doc.name.replace(/\.docx?$/i, '');
      const slug = slugify(name);
      const ext = path.extname(doc.file_path).slice(1) || 'docx';

      // Try to match by current file_path or by slug+category; otherwise insert
      const { rows: existing } = await client.query(
        `SELECT id FROM doc_templates WHERE slug = $1 AND category_id = $2 LIMIT 1`,
        [slug, parentId]
      );

      if (existing.length) {
        await client.query(
          `UPDATE doc_templates
           SET name = $1, file_path = $2, file_name = $3, doc_type = $4,
               description = $5, is_active = true, updated_at = NOW()
           WHERE id = $6`,
          [name, doc.file_path, doc.name, ext, doc.description || `Plantilla: ${name}`, existing[0].id]
        );
      } else {
        await client.query(
          `INSERT INTO doc_templates (name, slug, category_id, file_path, file_name, doc_type, description, is_active, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, 0)`,
          [name, slug, parentId, doc.file_path, doc.name, ext, doc.description || `Plantilla: ${name}`]
        );
      }
    }

    await client.query('COMMIT');
    console.log('Templates reseeded successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Reseed failed:', err);
  process.exit(1);
});
