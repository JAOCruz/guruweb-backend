-- Permitir storage_type 'railway_volume' en tablas de documentos y facturas
ALTER TABLE client_documents DROP CONSTRAINT IF EXISTS client_documents_storage_type_check;
ALTER TABLE client_documents ADD CONSTRAINT client_documents_storage_type_check
  CHECK (storage_type IN ('local', 's3', 'railway_volume'));

ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_pdf_storage_type_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_pdf_storage_type_check
  CHECK (pdf_storage_type IN ('local', 's3', 'railway_volume'));
