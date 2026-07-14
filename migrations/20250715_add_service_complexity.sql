-- Add complexity classification (Sencillo/Extensivo/Avanzado) to service_catalog
ALTER TABLE service_catalog
  ADD COLUMN IF NOT EXISTS complexity VARCHAR(1) CHECK (complexity IN ('S', 'E', 'A'));

CREATE INDEX IF NOT EXISTS idx_service_catalog_complexity ON service_catalog(complexity);
