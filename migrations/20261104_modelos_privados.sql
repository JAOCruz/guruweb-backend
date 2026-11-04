-- Documentos · cualquier usuario sube su propio modelo: empieza privado (lo ven quien lo subió y los admins)
-- y solo al publicarlo el admin sale a todos. Un modelo privado nunca está publicado. Idempotente.
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS created_by INT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE doc_templates ADD COLUMN IF NOT EXISTS publish_requested_at TIMESTAMPTZ;
ALTER TABLE doc_templates DROP CONSTRAINT IF EXISTS doc_templates_private_not_published;
ALTER TABLE doc_templates ADD CONSTRAINT doc_templates_private_not_published
  CHECK (NOT is_private OR approved_tag_version_id IS NULL);
CREATE INDEX IF NOT EXISTS idx_doc_templates_private_owner ON doc_templates(created_by) WHERE is_private;
