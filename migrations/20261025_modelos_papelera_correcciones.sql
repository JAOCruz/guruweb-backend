-- Documentos · models can go to the trash (hidden everywhere, the admin restores them) and anyone
-- can report a correction on a model; the admin applies it (a new version) or dismisses it. Idempotent.
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS deleted_by INT REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS template_corrections (
  id                   SERIAL PRIMARY KEY,
  template_id          INT NOT NULL REFERENCES doc_templates(id) ON DELETE CASCADE,
  -- the version on screen when it was reported, and the paragraph / words pointed at (optional)
  version_id           INT REFERENCES template_tag_versions(id) ON DELETE SET NULL,
  paragraph_i          INT,
  excerpt              TEXT,
  comment              TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'dismissed')),
  created_by           INT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by          INT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at          TIMESTAMPTZ,
  resolution_note      TEXT,
  -- the version that applied it
  resulting_version_id INT REFERENCES template_tag_versions(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_template_corrections_template ON template_corrections(template_id, status);
