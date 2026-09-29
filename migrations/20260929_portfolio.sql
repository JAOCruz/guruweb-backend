-- Documentos · Historial del digitador: personalized documents per client, with versions.
-- Only the creator and the admin see a document. One approved version per document. Idempotent.
CREATE TABLE IF NOT EXISTS portfolio_documents (
  id                  SERIAL PRIMARY KEY,
  client_id           INT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title               VARCHAR(200) NOT NULL,
  template_id         INT,
  created_by          INT REFERENCES users(id) ON DELETE SET NULL,
  approved_version_id INT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS portfolio_documents_owner_idx ON portfolio_documents (created_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS portfolio_documents_client_idx ON portfolio_documents (client_id);

CREATE TABLE IF NOT EXISTS portfolio_versions (
  id             SERIAL PRIMARY KEY,
  document_id    INT NOT NULL REFERENCES portfolio_documents(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  file_path      TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     INT,
  pdf_path       TEXT,
  source         VARCHAR(20) NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'generated', 'ai_edit')),
  notes          TEXT,
  created_by     INT REFERENCES users(id) ON DELETE SET NULL,
  approved_by    INT REFERENCES users(id) ON DELETE SET NULL,
  approved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, version_number)
);
