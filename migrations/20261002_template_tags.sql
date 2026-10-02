-- Documentos · Etiquetas: tagged copies of the models ({{TAG}} in place of a previous case's data),
-- with versions and the admin's approval. The original model files are never modified. Idempotent.
CREATE TABLE IF NOT EXISTS template_tag_versions (
  id             SERIAL PRIMARY KEY,
  template_id    INT NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  file_path      TEXT NOT NULL,
  tags           JSONB NOT NULL DEFAULT '[]',
  skipped        JSONB NOT NULL DEFAULT '[]',
  source         VARCHAR(20) NOT NULL DEFAULT 'ai' CHECK (source IN ('ai', 'edit', 'restore')),
  notes          TEXT,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by    INT REFERENCES users(id) ON DELETE SET NULL,
  approved_at    TIMESTAMPTZ,
  UNIQUE (template_id, version_number)
);
CREATE INDEX IF NOT EXISTS template_tag_versions_template_idx ON template_tag_versions (template_id, version_number DESC);

ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS approved_tag_version_id INT;
