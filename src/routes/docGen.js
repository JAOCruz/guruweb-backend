const express = require('express');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const path = require('path');
const fs = require('fs');
const ClientDocument = require('../models/ClientDocument');
const { isS3Configured, uploadLocalFile, getS3Key, getSignedDownloadUrl } = require('../utils/s3');
const storage = require('../utils/storage');

const router = express.Router();
router.use(authenticate);

// ── GET /api/docgen/categories ── List all document categories with templates
router.get('/categories', async (req, res) => {
  try {
    const { rows: categories } = await pool.query(`
      SELECT c.id, c.name, c.slug, c.parent_id,
        json_agg(json_build_object(
          'id', t.id,
          'name', t.name,
          'slug', t.slug,
          'description', t.description,
          'doc_type', t.doc_type,
          'required_roles', t.required_roles
        ) ORDER BY t.sort_order, t.name) FILTER (WHERE t.id IS NOT NULL) AS templates
      FROM doc_categories c
      LEFT JOIN doc_templates t ON t.category_id = c.id AND t.is_active = true
      GROUP BY c.id
      ORDER BY c.sort_order, c.name
    `);
    res.json({ categories });
  } catch (err) {
    console.error('DocGen categories error:', err);
    res.status(500).json({ error: 'Failed to load categories' });
  }
});

// ── GET /api/docgen/templates ── List all templates (flat)
router.get('/templates', async (req, res) => {
  try {
    const { search, category } = req.query;
    let sql = `
      SELECT t.id, t.name, t.slug, t.description, t.doc_type, t.file_path,
        t.required_roles, t.estimated_price_min, t.estimated_price_max,
        c.name AS category_name, c.slug AS category_slug
      FROM doc_templates t
      LEFT JOIN doc_categories c ON c.id = t.category_id
      WHERE t.is_active = true
    `;
    const params = [];
    if (search) {
      sql += ` AND (t.name ILIKE $${params.length + 1} OR t.description ILIKE $${params.length + 1})`;
      params.push(`%${search}%`);
    }
    if (category) {
      sql += ` AND c.slug = $${params.length + 1}`;
      params.push(category);
    }
    sql += ` ORDER BY t.sort_order, t.name`;
    const { rows } = await pool.query(sql, params);
    res.json({ templates: rows });
  } catch (err) {
    console.error('DocGen templates error:', err);
    res.status(500).json({ error: 'Failed to load templates' });
  }
});

// ── GET /api/docgen/templates/:id ── Get template detail with variables
router.get('/templates/:id', async (req, res) => {
  try {
    const { rows: [template] } = await pool.query(`
      SELECT t.*, c.name AS category_name
      FROM doc_templates t
      LEFT JOIN doc_categories c ON c.id = t.category_id
      WHERE t.id = $1
    `, [req.params.id]);

    if (!template) return res.status(404).json({ error: 'Template not found' });

    // Get required variables
    const { rows: variables } = await pool.query(`
      SELECT v.tag, v.description, v.data_source, v.format_expected,
        v.is_rol_dynamic, v.rol_type, tv.is_required
      FROM doc_template_variables tv
      JOIN doc_variables v ON v.id = tv.variable_id
      WHERE tv.template_id = $1
      ORDER BY tv.sort_order, v.tag
    `, [req.params.id]);

    // Analyze roles needed (using Python generator)
    const { spawnSync } = require('child_process');
    const script = `
import sys, json
from src.documents.motherbrainGenerator import analyze_template_roles
roles = analyze_template_roles(sys.argv[1])
print(json.dumps(roles))
`;
    const result = spawnSync('python3', ['-c', script, template.file_path], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf-8',
      timeout: 10000,
    });
    let requiredRoles = {};
    if (result.status === 0) {
      try { requiredRoles = JSON.parse(result.stdout.trim()); } catch (e) {}
    }

    res.json({ template, variables, requiredRoles });
  } catch (err) {
    console.error('DocGen template detail error:', err);
    res.status(500).json({ error: 'Failed to load template' });
  }
});

// ── POST /api/docgen/sessions ── Create a document generation session
router.post('/sessions', async (req, res) => {
  try {
    const { templateId, clientId, phone } = req.body;
    if (!templateId) return res.status(400).json({ error: 'templateId is required' });

    const { rows: [session] } = await pool.query(`
      INSERT INTO doc_generation_sessions (template_id, client_id, phone, status, collected_data, assigned_roles)
      VALUES ($1, $2, $3, 'collecting', '{}', '{}')
      RETURNING *
    `, [templateId, clientId || null, phone || null]);

    res.status(201).json({ session });
  } catch (err) {
    console.error('DocGen create session error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ── GET /api/docgen/sessions/:id ── Get session status
router.get('/sessions/:id', async (req, res) => {
  try {
    const { rows: [session] } = await pool.query(`
      SELECT s.*, t.name AS template_name, t.file_path
      FROM doc_generation_sessions s
      JOIN doc_templates t ON t.id = s.template_id
      WHERE s.id = $1
    `, [req.params.id]);

    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  } catch (err) {
    console.error('DocGen get session error:', err);
    res.status(500).json({ error: 'Failed to load session' });
  }
});

// ── PUT /api/docgen/sessions/:id/data ── Update collected data
router.put('/sessions/:id/data', async (req, res) => {
  try {
    const { collectedData, assignedRoles } = req.body;

    const { rows: [session] } = await pool.query(`
      UPDATE doc_generation_sessions
      SET collected_data = collected_data || $1::jsonb,
          assigned_roles = assigned_roles || $2::jsonb,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *
    `, [JSON.stringify(collectedData || {}), JSON.stringify(assignedRoles || {}), req.params.id]);

    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json({ session });
  } catch (err) {
    console.error('DocGen update session error:', err);
    res.status(500).json({ error: 'Failed to update session' });
  }
});

// ── POST /api/docgen/sessions/:id/generate ── Generate the document
router.post('/sessions/:id/generate', async (req, res) => {
  try {
    const { rows: [session] } = await pool.query(`
      SELECT s.*, t.file_path, t.name AS template_name
      FROM doc_generation_sessions s
      JOIN doc_templates t ON t.id = s.template_id
      WHERE s.id = $1
    `, [req.params.id]);

    if (!session) return res.status(404).json({ error: 'Session not found' });

    const collectedData = session.collected_data || {};
    const assignedRoles = session.assigned_roles || {};

    // Generate document via Python
    const { spawnSync } = require('child_process');
    const script = `
import sys, json
from src.documents.motherbrainGenerator import generate_document

data = json.loads(sys.argv[1])
roles = json.loads(sys.argv[2])
output = generate_document(sys.argv[3], data, roles, sys.argv[4])
print(output)
`;
    const outputName = `${session.id}_${Date.now()}.docx`;
    const result = spawnSync('python3', ['-c', script,
      JSON.stringify(collectedData),
      JSON.stringify(assignedRoles),
      session.file_path,
      outputName
    ], {
      cwd: path.resolve(__dirname, '../..'),
      encoding: 'utf-8',
      timeout: 30000,
    });

    if (result.status !== 0) {
      throw new Error(result.stderr || 'Generation failed');
    }

    const generatedPath = result.stdout.trim();

    // Move generated file to persistent Railway volume storage
    let outputPath = generatedPath;
    let storageType = 'local';
    let s3Key = null;
    let s3Url = null;
    try {
      const safeName = `${session.id}_${Date.now()}.docx`;
      outputPath = storage.saveLocalFile(generatedPath, 'documents', safeName);
      storageType = 'railway_volume';
      console.log(`[DocGen] Saved to Railway volume: ${outputPath}`);
      // Clean up the original temporary file
      try { fs.unlinkSync(generatedPath); } catch {}
    } catch (storageErr) {
      console.error('[DocGen] Railway volume save failed, keeping temporary file:', storageErr.message);
      outputPath = generatedPath;
    }

    // Upload to S3 if configured (dual storage for backup/accessibility)
    if (isS3Configured()) {
      try {
        const key = getS3Key('documents', `${session.id}_${Date.now()}.docx`);
        const upload = await uploadLocalFile(outputPath, key, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        s3Key = upload.key;
        s3Url = upload.url;
        console.log(`[DocGen] Uploaded to S3: ${s3Key}`);
      } catch (s3Err) {
        console.error('[DocGen] S3 upload failed:', s3Err.message);
      }
    }

    // Update session
    await pool.query(`
      UPDATE doc_generation_sessions
      SET status = 'generated', generated_file_path = $1, generated_at = NOW()
      WHERE id = $2
    `, [outputPath, req.params.id]);

    // Version control: store generated document in client_documents
    try {
      const latestVersion = await ClientDocument.getLatestVersion(
        session.client_id,
        session.template_id,
        null // doc generation sessions are not yet tied to a case
      );
      await ClientDocument.create({
        clientId: session.client_id,
        docGenerationSessionId: session.id,
        templateId: session.template_id,
        versionNumber: latestVersion + 1,
        filePath: outputPath,
        fileName: path.basename(outputPath),
        generatedByUserId: req.user?.id || null,
        status: 'active',
        storageType: s3Key ? 's3' : storageType,
        s3Key,
        s3Url,
      });
    } catch (versionErr) {
      console.error('[DocGen] Failed to record document version:', versionErr.message);
      // Do not fail generation if versioning fails
    }

    res.json({
      success: true,
      filePath: outputPath,
      fileName: path.basename(outputPath),
      storageType: s3Key ? 's3' : storageType,
      s3Url,
    });
  } catch (err) {
    console.error('DocGen generate error:', err);
    res.status(500).json({ error: 'Failed to generate document', details: err.message });
  }
});

// ── GET /api/docgen/sessions/:id/download ── Download generated document
router.get('/sessions/:id/download', async (req, res) => {
  try {
    const { rows: [docRecord] } = await pool.query(`
      SELECT storage_type, s3_key, file_path, file_name
      FROM client_documents
      WHERE doc_generation_session_id = $1
      ORDER BY version_number DESC
      LIMIT 1
    `, [req.params.id]);

    // Fallback to session table for legacy documents
    let session = null;
    if (!docRecord) {
      const { rows: [s] } = await pool.query(`
        SELECT generated_file_path FROM doc_generation_sessions WHERE id = $1
      `, [req.params.id]);
      session = s;
    }

    const filePath = docRecord?.file_path || session?.generated_file_path;
    if (!filePath) {
      return res.status(404).json({ error: 'Document not yet generated' });
    }

    // Serve from S3 if available
    if (docRecord?.storage_type === 's3' && docRecord.s3_key) {
      try {
        const signedUrl = await getSignedDownloadUrl(docRecord.s3_key);
        return res.redirect(signedUrl);
      } catch (s3Err) {
        console.error('[DocGen] Failed to generate S3 signed URL:', s3Err.message);
        // Fall through to volume/local file
      }
    }

    const absPath = path.resolve(filePath);
    const allowedRoots = [
      path.resolve(__dirname, '..', '..', 'templates', 'output'),
      path.resolve(storage.getStorageRoot()),
    ];
    if (!allowedRoots.some((root) => absPath.startsWith(root))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(absPath)}"`);
    res.sendFile(absPath);
  } catch (err) {
    console.error('DocGen download error:', err);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

// ── GET /api/docgen/roles ── List all available ROL roles
router.get('/roles', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT code, name, name_es, category, description
      FROM doc_roles WHERE is_active = true ORDER BY sort_order, name_es
    `);
    res.json({ roles: rows });
  } catch (err) {
    console.error('DocGen roles error:', err);
    res.status(500).json({ error: 'Failed to load roles' });
  }
});

module.exports = router;
