// Biblioteca legal en el panel: leyes cargadas, temas e instituciones (los escribe el admin) y una búsqueda para
// probar lo que encontraría el bot.
const express = require('express');
const pool = require('../db/pool');
const library = require('../legal/library');
const { buscar_ley } = require('../agent/tools/legal');
const { authenticate, requireRole } = require('../middleware/auth');
const { logActivity, safeLog } = require('../services/activityLog');

const router = express.Router();
router.use(authenticate);

const FIELDS = ['kind', 'title', 'keywords', 'body', 'legal_basis', 'url'];
const KINDS = ['tema', 'institucion'];
const clean = (v) => (v == null ? null : String(v).trim().slice(0, 8000) || null);

router.get('/laws', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT code, title, short, source_name, source_url, fetched_at, article_count, loaded_at FROM legal_laws ORDER BY short');
    res.json({ laws: rows });
  } catch (err) {
    console.error('Legal laws error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudieron cargar las leyes' });
  }
});

router.get('/topics', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.kind, t.title, t.keywords, t.body, t.legal_basis, t.url, t.active, t.source, t.updated_at,
              u.name AS updated_by_name
       FROM legal_topics t LEFT JOIN users u ON u.id = t.updated_by ORDER BY t.kind, t.title`);
    res.json({ topics: rows });
  } catch (err) {
    console.error('Legal topics error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudieron cargar los temas' });
  }
});

router.get('/search', async (req, res) => {
  try {
    res.json(await buscar_ley({ consulta: req.query.q }));
  } catch (err) {
    console.error('Legal search error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudo buscar' });
  }
});

function validate(t, partial) {
  if (!partial || t.title !== undefined) if (!clean(t.title)) return 'Falta el título';
  if (!partial || t.body !== undefined) if (!clean(t.body)) return 'Falta la explicación';
  if (t.kind !== undefined && !KINDS.includes(t.kind)) return 'Tipo no válido';
  return null;
}

async function saveSearch(id) {
  const { rows } = await pool.query('SELECT * FROM legal_topics WHERE id = $1', [id]);
  if (!rows[0]) return null;
  const { rows: out } = await pool.query(
    `UPDATE legal_topics SET search = to_tsvector('spanish', $2) WHERE id = $1 RETURNING *`,
    [id, library.topicSearchText(rows[0])]);
  return out[0];
}

router.post('/topics', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const bad = validate(body, false);
    if (bad) return res.status(400).json({ error: bad });
    const vals = FIELDS.map((k) => (k === 'kind' ? body.kind || 'tema' : clean(body[k])));
    const { rows } = await pool.query(
      `INSERT INTO legal_topics (${FIELDS.join(', ')}, source, updated_by, search)
       VALUES ($1,$2,$3,$4,$5,$6,'manual',$7, ''::tsvector) RETURNING id`, [...vals, req.user.id]);
    const topic = await saveSearch(rows[0].id);
    await safeLog(() => logActivity(req, {
      category: 'leyes', action: 'legal_topic.create', entityType: 'legal_topic', entityId: topic.id,
      summary: `Agregó el tema legal «${topic.title.slice(0, 80)}»`,
    }));
    res.status(201).json({ topic });
  } catch (err) {
    console.error('Legal topic create error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudo guardar el tema' });
  }
});

router.put('/topics/:id', requireRole('admin'), async (req, res) => {
  try {
    const body = req.body || {};
    const bad = validate(body, true);
    if (bad) return res.status(400).json({ error: bad });
    const keys = FIELDS.filter((k) => body[k] !== undefined);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const vals = keys.map((k) => (k === 'kind' ? body.kind : clean(body[k])));
    if (typeof body.active === 'boolean') { sets.push(`active = $${vals.length + 1}`); vals.push(body.active); }
    vals.push(req.user.id, Number(req.params.id) || 0);
    const { rowCount } = await pool.query(
      `UPDATE legal_topics SET ${[...sets, `updated_by = $${vals.length - 1}`].join(', ')}, source = 'manual', updated_at = NOW()
       WHERE id = $${vals.length}`, vals);
    if (!rowCount) return res.status(404).json({ error: 'Tema no encontrado' });
    const topic = await saveSearch(Number(req.params.id));
    await safeLog(() => logActivity(req, {
      category: 'leyes', action: 'legal_topic.update', entityType: 'legal_topic', entityId: topic.id,
      summary: `${body.active === false ? 'Desactivó' : body.active === true ? 'Activó' : 'Editó'} el tema legal «${topic.title.slice(0, 80)}»`,
    }));
    res.json({ topic });
  } catch (err) {
    console.error('Legal topic update error:', err.code || err.message);
    res.status(500).json({ error: 'No se pudo guardar el tema' });
  }
});

module.exports = router;
