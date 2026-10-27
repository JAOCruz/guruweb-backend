-- Documentos · al subir un documento al historial el cliente es opcional (Leandro, 2026-10-27).
-- Los documentos sin cliente aparecen en el historial como «Sin cliente». Idempotente.
ALTER TABLE portfolio_documents ALTER COLUMN client_id DROP NOT NULL;

SELECT 'Migration 20261027_documentos_sin_cliente completed successfully' AS status;
