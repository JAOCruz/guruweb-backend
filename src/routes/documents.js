const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

// Legacy path to the generated document index JSON (kept for fallback)
const DOCUMENT_INDEX_PATH = '/home/jay/Projects/guru-whatsapp-bot/DB/document_index.json';

router.use(authenticate);

// GET /api/documents/index — fetch complete document index
// Primary source: doc_templates/doc_categories in PostgreSQL.
// Fallback to legacy JSON file if it exists locally.
router.get('/index', async (req, res) => {
  try {
    // Try database first
    const { rows: templates } = await pool.query(`
      SELECT t.id, t.name, t.slug, t.file_path, t.file_name, t.doc_type,
             t.description, t.required_roles, t.created_at, t.updated_at,
             c.name AS category_name, c.slug AS category_slug,
             p.name AS parent_category_name, p.slug AS parent_category_slug
      FROM doc_templates t
      LEFT JOIN doc_categories c ON c.id = t.category_id
      LEFT JOIN doc_categories p ON p.id = c.parent_id
      WHERE t.is_active = true
      ORDER BY c.sort_order, c.name, t.sort_order, t.name
    `);

    if (templates.length > 0) {
      const categories = [...new Set(templates.map(t => t.category_slug).filter(Boolean))].sort();
      const documents = templates.map(t => {
        const parts = [t.parent_category_name, t.category_name].filter(Boolean);
        return {
          id: String(t.id),
          name: t.name,
          category: t.parent_category_name || t.category_name || 'General',
          subcategory: t.parent_category_name ? t.category_name : null,
          sub_subcategory: null,
          specialization: parts.join(' / '),
          file_path: t.file_path,
          absolute_path: t.file_path,
          file_extension: t.doc_type ? `.${t.doc_type}` : '.docx',
          file_size_bytes: 0,
          modified_date: t.updated_at ? new Date(t.updated_at).toISOString() : new Date().toISOString(),
          status: 'active',
          description: t.description || `Plantilla: ${t.name}`,
          tags: Array.isArray(t.required_roles) ? t.required_roles : [],
          comments: [],
        };
      });

      return res.json({
        metadata: {
          total_documents: documents.length,
          generated_at: new Date().toISOString(),
          base_path: '/',
        },
        categories,
        documents,
        grouped_by_category: documents.reduce((acc, d) => {
          acc[d.category] = (acc[d.category] || 0) + 1;
          return acc;
        }, {}),
      });
    }

    // Fallback to legacy JSON file
    if (!fs.existsSync(DOCUMENT_INDEX_PATH)) {
      return res.status(404).json({
        error: 'Document index not found. Please run the document indexing script first.'
      });
    }

    const indexData = fs.readFileSync(DOCUMENT_INDEX_PATH, 'utf8');
    const documentIndex = JSON.parse(indexData);

    res.json(documentIndex);
  } catch (err) {
    console.error('Error reading document index:', err);
    res.status(500).json({ error: 'Failed to load document index' });
  }
});

// POST /api/documents/:id/comment — add comment to document metadata
router.post('/:id/comment', authenticate, async (req, res) => {
  try {
    const { text, author } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Comment text is required' });
    }

    if (!fs.existsSync(DOCUMENT_INDEX_PATH)) {
      return res.status(404).json({ error: 'Document index not found' });
    }

    const indexData = fs.readFileSync(DOCUMENT_INDEX_PATH, 'utf8');
    const documentIndex = JSON.parse(indexData);

    const document = documentIndex.documents.find(d => d.id === req.params.id);
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Add comment to document
    if (!document.comments) {
      document.comments = [];
    }

    const newComment = {
      id: `comment_${Date.now()}`,
      text,
      author: author || req.user?.username || 'System',
      created_at: new Date().toISOString()
    };

    document.comments.push(newComment);

    // Write updated index back to file
    fs.writeFileSync(DOCUMENT_INDEX_PATH, JSON.stringify(documentIndex, null, 2));

    res.json({
      success: true,
      comment: newComment,
      message: 'Comment added successfully'
    });
  } catch (err) {
    console.error('Error adding comment:', err);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// PUT /api/documents/:id — update document metadata (description, tags, status)
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { description, tags, status } = req.body;

    if (!fs.existsSync(DOCUMENT_INDEX_PATH)) {
      return res.status(404).json({ error: 'Document index not found' });
    }

    const indexData = fs.readFileSync(DOCUMENT_INDEX_PATH, 'utf8');
    const documentIndex = JSON.parse(indexData);

    const document = documentIndex.documents.find(d => d.id === req.params.id);
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Update allowed fields
    if (description !== undefined) document.description = description;
    if (tags !== undefined) document.tags = Array.isArray(tags) ? tags : [];
    if (status !== undefined) document.status = status;

    // Write updated index back to file
    fs.writeFileSync(DOCUMENT_INDEX_PATH, JSON.stringify(documentIndex, null, 2));

    res.json({
      success: true,
      document,
      message: 'Document updated successfully'
    });
  } catch (err) {
    console.error('Error updating document:', err);
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// GET /api/documents/search?q=term — search documents by name or description
router.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    if (!fs.existsSync(DOCUMENT_INDEX_PATH)) {
      return res.status(404).json({ error: 'Document index not found' });
    }

    const indexData = fs.readFileSync(DOCUMENT_INDEX_PATH, 'utf8');
    const documentIndex = JSON.parse(indexData);

    const query = q.toLowerCase();
    const results = documentIndex.documents.filter(doc =>
      doc.name.toLowerCase().includes(query) ||
      doc.description.toLowerCase().includes(query) ||
      doc.category.toLowerCase().includes(query) ||
      doc.subcategory?.toLowerCase().includes(query)
    );

    res.json({
      results,
      count: results.length
    });
  } catch (err) {
    console.error('Error searching documents:', err);
    res.status(500).json({ error: 'Failed to search documents' });
  }
});

// GET /api/documents/file/:docId — stream a document file
router.get('/file/:docId', async (req, res) => {
  try {
    if (!fs.existsSync(DOCUMENT_INDEX_PATH)) {
      return res.status(404).json({ error: 'Document index not found' });
    }

    const indexData = fs.readFileSync(DOCUMENT_INDEX_PATH, 'utf8');
    const documentIndex = JSON.parse(indexData);

    const document = documentIndex.documents.find(d => d.id === req.params.docId);
    if (!document) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const filePath = document.absolute_path;

    // Security: validate the path stays within the known base directory
    const BASE_PATH = '/home/jay/Projects/guru-whatsapp-bot/DB';
    const resolvedPath = path.resolve(filePath);
    if (!resolvedPath.startsWith(path.resolve(BASE_PATH))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ error: 'File not found on disk' });
    }

    const ext = document.file_extension.toLowerCase();
    const contentTypes = {
      '.pdf':  'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc':  'application/msword',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(resolvedPath)}"`);
    res.sendFile(resolvedPath);
  } catch (err) {
    console.error('Error serving document file:', err);
    res.status(500).json({ error: 'Failed to serve document' });
  }
});

module.exports = router;
