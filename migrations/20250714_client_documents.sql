-- Control de versiones de documentos generados para clientes
CREATE TABLE IF NOT EXISTS client_documents (
  id SERIAL PRIMARY KEY,
  client_id INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  case_id INTEGER REFERENCES cases(id) ON DELETE SET NULL,
  doc_generation_session_id INTEGER REFERENCES doc_generation_sessions(id) ON DELETE SET NULL,
  template_id INTEGER REFERENCES doc_templates(id) ON DELETE SET NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  file_path TEXT,
  file_name TEXT NOT NULL,
  generated_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revised', 'obsolete')),
  notes TEXT,
  parent_document_id INTEGER REFERENCES client_documents(id) ON DELETE SET NULL,
  storage_type VARCHAR(20) NOT NULL DEFAULT 'local' CHECK (storage_type IN ('local', 's3')),
  s3_key TEXT,
  s3_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_documents_client_id ON client_documents(client_id);
CREATE INDEX IF NOT EXISTS idx_client_documents_case_id ON client_documents(case_id);
CREATE INDEX IF NOT EXISTS idx_client_documents_template_id ON client_documents(template_id);
CREATE INDEX IF NOT EXISTS idx_client_documents_status ON client_documents(status);

-- Garantiza versionado secuencial por cliente/plantilla/caso
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_documents_version
  ON client_documents(client_id, template_id, COALESCE(case_id, 0), version_number);

-- Trigger para actualizar updated_at
CREATE OR REPLACE FUNCTION update_client_documents_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_client_documents_updated_at ON client_documents;
CREATE TRIGGER trg_client_documents_updated_at
  BEFORE UPDATE ON client_documents
  FOR EACH ROW
  EXECUTE FUNCTION update_client_documents_updated_at();
