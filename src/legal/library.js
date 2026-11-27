// Biblioteca legal: carga las leyes de seeds/leyes/*.json (separadas por artículo) y los temas/instituciones de
// seeds/leyes/temas.json e instituciones.json, y busca en ellos para el bot (herramienta buscar_ley) y el panel.
// Las leyes se recargan solo cuando cambia su archivo (versión = hash). Los temas de la semilla nunca pisan uno que
// el equipo ya editó.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const pool = require('../db/pool');
const { fold } = require('../../scripts/leyes/articulos');

const SEEDS = path.join(__dirname, '..', '..', 'seeds', 'leyes');
const TOPIC_FILES = ['temas.json', 'instituciones.json'];
const BATCH = 300;

// Most articles start with their own name: "Duplicado del Certificado de Título. El duplicado…"
const heading = (text) => {
  const m = String(text).match(/^(.{3,120}?)\.\s/);
  return m ? m[1] : '';
};

const topicSearchText = (t) => fold([t.title, t.keywords, t.body, t.legal_basis].filter(Boolean).join(' '));

async function loadLaw(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const version = crypto.createHash('sha1').update(raw).digest('hex');
  const law = JSON.parse(raw);
  const cur = await pool.query('SELECT version FROM legal_laws WHERE code = $1', [law.code]);
  if (cur.rows[0]?.version === version) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO legal_laws (code, title, short, source_name, source_url, fetched_at, version, article_count, loaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, short = EXCLUDED.short, source_name = EXCLUDED.source_name,
         source_url = EXCLUDED.source_url, fetched_at = EXCLUDED.fetched_at, version = EXCLUDED.version,
         article_count = EXCLUDED.article_count, loaded_at = NOW()`,
      [law.code, law.title, law.short, law.source_name || null, law.source_url || null, law.fetched_at || null, version, law.articles.length]);
    await client.query('DELETE FROM legal_articles WHERE law_code = $1', [law.code]);
    for (let i = 0; i < law.articles.length; i += BATCH) {
      const chunk = law.articles.slice(i, i + BATCH);
      await client.query(
        `INSERT INTO legal_articles (law_code, num, ord, section, text, search)
         SELECT $1, a.num, a.ord, a.section, a.text,
                setweight(to_tsvector('spanish', a.head), 'A') || setweight(to_tsvector('spanish', a.body), 'B')
         FROM unnest($2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[]) AS a(num, ord, section, text, head, body)`,
        [law.code, chunk.map((a) => a.num), chunk.map((a) => a.ord), chunk.map((a) => a.section || null),
          chunk.map((a) => a.text), chunk.map((a) => fold(`${a.section || ''} ${heading(a.text)}`)), chunk.map((a) => fold(a.text))]);
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function loadTopics(file) {
  const list = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  for (const t of list) {
    const { rowCount } = await pool.query(
      `INSERT INTO legal_topics (seed_key, kind, title, keywords, body, legal_basis, url, source, search)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'seed', to_tsvector('spanish', $8))
       ON CONFLICT (seed_key) DO UPDATE SET kind = EXCLUDED.kind, title = EXCLUDED.title, keywords = EXCLUDED.keywords,
         body = EXCLUDED.body, legal_basis = EXCLUDED.legal_basis, url = EXCLUDED.url, search = EXCLUDED.search, updated_at = NOW()
       WHERE legal_topics.source = 'seed'
         AND (legal_topics.title, legal_topics.keywords, legal_topics.body, legal_topics.legal_basis, legal_topics.url)
           IS DISTINCT FROM (EXCLUDED.title, EXCLUDED.keywords, EXCLUDED.body, EXCLUDED.legal_basis, EXCLUDED.url)`,
      [t.seed_key, t.kind || 'tema', t.title, t.keywords || null, t.body, t.legal_basis || null, t.url || null, topicSearchText(t)]);
    n += rowCount;
  }
  return n;
}

// Returns { loaded: [codes reloaded], topics: rows inserted or updated }
async function loadLegalLibrary({ dir = SEEDS } = {}) {
  if (!fs.existsSync(dir)) return { loaded: [], topics: 0 };
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const loaded = [];
  let topics = 0;
  for (const f of files) {
    const file = path.join(dir, f);
    if (TOPIC_FILES.includes(f)) topics += await loadTopics(file);
    else if (await loadLaw(file)) loaded.push(f.replace(/\.json$/, ''));
  }
  return { loaded, topics };
}

// Words of the question, without the empty ones the Spanish dictionary drops anyway
const words = (q) => fold(q).replace(/[^a-z0-9ñ\s-]/g, ' ').split(/\s+/).filter((w) => w.length > 2);

// "artículo 93 de la 108-05" / "art. 112 del código civil" → that article directly
async function directArticle(q) {
  const f = fold(q);
  const num = f.match(/\bart(?:iculo|\.)?\s*(\d{1,4})\b/)?.[1];
  if (!num) return [];
  const lawNum = f.match(/\b(\d{1,4}-\d{2})\b/)?.[1];
  const { rows } = await pool.query(
    `SELECT a.*, l.short, l.source_url FROM legal_articles a JOIN legal_laws l ON l.code = a.law_code
     WHERE a.num = $1 AND ($2::text IS NULL OR l.short ILIKE '%' || $2 || '%' OR l.title ILIKE '%' || $2 || '%')
       AND ($3::boolean = false OR l.code = 'codigo-civil')
     ORDER BY a.law_code LIMIT 3`,
    [num, lawNum || null, /codigo civil/.test(f)]);
  return rows;
}

// Words the Spanish dictionary drops (stop words) are left out of the OR query
const orQuery = (w) => w.map((x) => x.replace(/[^a-z0-9ñ]/g, '')).filter(Boolean).join(' | ');

// Rank: how many of the question's words the article has (each counts once), then the words in its name (weight A)
// over the body (B), with long articles penalized so they do not win just by being long.
async function searchArticles(q, limit) {
  const w = [...new Set(words(q))].slice(0, 12);
  if (!w.length) return [];
  const coverage = w.map((_, i) => `(a.search @@ plainto_tsquery('spanish', $${i + 3}))::int`).join(' + ');
  const { rows } = await pool.query(
    `SELECT a.*, l.short, l.source_url,
            (${coverage}) + ts_rank('{0.1, 0.2, 0.4, 1.0}', a.search, to_tsquery('spanish', $1), 1) * 2 AS rank
     FROM legal_articles a JOIN legal_laws l ON l.code = a.law_code
     WHERE a.search @@ to_tsquery('spanish', $1)
     ORDER BY rank DESC, a.law_code, a.ord LIMIT $2`,
    [orQuery(w), limit, ...w]);
  const best = rows[0]?.rank || 0;
  return rows.filter((r) => r.rank >= best * 0.5);
}

async function searchTopics(q, limit) {
  const w = words(q);
  if (!w.length) return [];
  const { rows } = await pool.query(
    `SELECT *, ts_rank_cd(search, to_tsquery('spanish', $1)) AS rank FROM legal_topics
     WHERE active AND search @@ to_tsquery('spanish', $1) ORDER BY rank DESC, id LIMIT $2`,
    [w.join(' | '), limit]);
  return rows;
}

const MIN_TOPIC_RANK = 0.1;

async function search(query, { limit = 5 } = {}) {
  const direct = await directArticle(query);
  const found = direct.length ? direct : await searchArticles(query, limit);
  const found2 = await searchTopics(query, 3);
  const bestTopic = found2[0]?.rank || 0;
  const topics = found2.filter((t, i) => i === 0 || (t.rank >= MIN_TOPIC_RANK && t.rank >= bestTopic * 0.5));
  return { articles: found.slice(0, limit), topics };
}

module.exports = { loadLegalLibrary, search, topicSearchText, SEEDS };
