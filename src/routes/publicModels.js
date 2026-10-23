const express = require('express');
const pool = require('../db/pool');

// Public, read-only list for the website's "Ventanilla Gurú": the models an admin approved in
// Revisión de etiquetas. Only names and categories — never files, versions or client data.
// Mounted before the app's CORS check so any page can read it (GET, no cookies).
const router = express.Router();

router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

router.get('/models', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, c.name AS category
       FROM doc_templates t LEFT JOIN doc_categories c ON c.id = t.category_id
       WHERE t.is_active = TRUE AND t.approved_tag_version_id IS NOT NULL
       ORDER BY c.name NULLS LAST, t.name`
    );
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ models: rows });
  } catch (err) {
    console.error('Public models error:', err.message);
    res.status(500).json({ error: 'No se pudo cargar la lista' });
  }
});

module.exports = router;
