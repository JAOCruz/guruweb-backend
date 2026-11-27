-- Biblioteca legal del bot (Leandro, 2026-11-27): leyes dominicanas separadas por artículo (de fuentes públicas,
-- seeds/leyes/*.json) y temas e instituciones que escribe el equipo. El bot solo cita lo que está aquí.
-- La búsqueda usa texto sin acentos en minúsculas (lo prepara src/legal/library.js). Idempotente.
CREATE TABLE IF NOT EXISTS legal_laws (
  code VARCHAR(60) PRIMARY KEY,
  title TEXT NOT NULL,
  short TEXT NOT NULL,
  source_name TEXT,
  source_url TEXT,
  fetched_at DATE,
  version VARCHAR(64) NOT NULL,
  article_count INT NOT NULL DEFAULT 0,
  loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS legal_articles (
  id SERIAL PRIMARY KEY,
  law_code VARCHAR(60) NOT NULL REFERENCES legal_laws(code) ON DELETE CASCADE,
  num VARCHAR(20) NOT NULL,
  ord INT NOT NULL,
  section TEXT,
  text TEXT NOT NULL,
  search TSVECTOR NOT NULL
);
CREATE INDEX IF NOT EXISTS legal_articles_search_idx ON legal_articles USING GIN (search);
CREATE INDEX IF NOT EXISTS legal_articles_law_num_idx ON legal_articles (law_code, num);

CREATE TABLE IF NOT EXISTS legal_topics (
  id SERIAL PRIMARY KEY,
  kind VARCHAR(20) NOT NULL DEFAULT 'tema' CHECK (kind IN ('tema', 'institucion')),
  title TEXT NOT NULL,
  keywords TEXT,
  body TEXT NOT NULL,
  legal_basis TEXT,
  url TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  source VARCHAR(20) NOT NULL DEFAULT 'manual',
  seed_key VARCHAR(80) UNIQUE,
  updated_by INT REFERENCES users(id) ON DELETE SET NULL,
  search TSVECTOR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS legal_topics_search_idx ON legal_topics USING GIN (search);
