-- ============================================================
-- Tiempos de entrega (respuestas de Leandro, punto 5 de pendientes)
-- Date: 2026-10-17
-- Aproximados; el bot los dice como "aproximadamente" y nunca como promesa.
-- Idempotente: se puede correr varias veces.
-- ============================================================

INSERT INTO business_info (clave, valor, updated_at) VALUES
  ('tiempos_entrega', $j$[
    {"servicio": "Digitación (redacción del documento)", "tiempo": "de 5 a 30 minutos"},
    {"servicio": "Notarización", "tiempo": "de 30 minutos a 24 horas", "nota": "es un trámite"},
    {"servicio": "Traducción", "tiempo": "de 1 a 24 horas", "nota": "es un trámite"},
    {"servicio": "Impresión", "tiempo": "inmediata", "nota": "por encargo depende del volumen, hasta 24 horas"},
    {"servicio": "Trámites ante instituciones", "tiempo": "de 24 a 48 horas", "nota": "algunos hasta 1 semana, según lo que tarde la institución en responder"}
  ]$j$::jsonb, NOW())
ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW();

SELECT 'Migration 20261019_tiempos_entrega completed successfully' AS status;
