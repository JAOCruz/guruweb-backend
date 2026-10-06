-- Bot fase 2: documentos preparados por el bot y entregas aprobadas por WhatsApp. Idempotente.
-- portfolio_documents: enlace a su cotización, modo de envío, marca de enviado (una sola vez) y último error.
ALTER TABLE portfolio_documents
  ADD COLUMN IF NOT EXISTS invoice_id INT,
  ADD COLUMN IF NOT EXISTS prepared_by_bot BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS send_mode TEXT,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_error TEXT;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'portfolio_documents_send_mode_check') THEN
    ALTER TABLE portfolio_documents ADD CONSTRAINT portfolio_documents_send_mode_check
      CHECK (send_mode IN ('al_pagar', 'ya', 'manual'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS portfolio_documents_invoice_idx ON portfolio_documents (invoice_id);

-- invoices: envío por el servicio de entregas (sent_at sigue siendo el estado "enviada" del panel).
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS sent_by_bot_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS send_error TEXT;

-- Switch de Configuración: los digitadores pueden aprobar y enviar documentos (apagado por defecto).
INSERT INTO business_info (clave, valor) VALUES ('digitadores_aprueban_documentos', 'false'::jsonb)
ON CONFLICT DO NOTHING;
