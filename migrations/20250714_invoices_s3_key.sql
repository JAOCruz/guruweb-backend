-- Agregar soporte para S3 en facturas/cotizaciones
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_s3_key TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS pdf_storage_type VARCHAR(20) DEFAULT 'local' CHECK (pdf_storage_type IN ('local', 's3', 'railway_volume'));
