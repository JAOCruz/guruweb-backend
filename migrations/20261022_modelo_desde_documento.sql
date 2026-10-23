-- Documentos · a client's personalized document can become a new version of its model ('client'):
-- the AI puts tags back in place of the client's data and the admin approves it. Idempotent.
ALTER TABLE template_tag_versions DROP CONSTRAINT IF EXISTS template_tag_versions_source_check;
ALTER TABLE template_tag_versions ADD CONSTRAINT template_tag_versions_source_check
  CHECK (source IN ('ai', 'edit', 'restore', 'client'));
-- the client document it came from (shown to admins only)
ALTER TABLE template_tag_versions ADD COLUMN IF NOT EXISTS origin_document_id INT REFERENCES portfolio_documents(id) ON DELETE SET NULL;
