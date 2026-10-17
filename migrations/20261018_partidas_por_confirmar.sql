-- ============================================================
-- Partidas por confirmar y reglas de rango (respuesta de Leandro, 2026-10-17)
--   - foja_tipo 'modificacion' (150 la foja; de 3 fojas en adelante, rango 100–150 que confirma el digitador)
--   - los 3 servicios con rango y precio fijo pasan a ser solo rango (el bot ya no pone el mínimo o el máximo)
--   - Modificación de Documento Existente va por foja (modificacion)
--   - notificaciones: carta motivada; notoriedades: legal motivada
-- Idempotente: se puede correr varias veces.
-- ============================================================

ALTER TABLE service_catalog DROP CONSTRAINT IF EXISTS service_catalog_foja_tipo_check;
ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_foja_tipo_check
  CHECK (foja_tipo IS NULL OR foja_tipo IN ('carta_simple','carta_motivada','legal_simple','legal_motivada','modificacion'));

UPDATE service_catalog SET digitacion_price = NULL
WHERE precio_rango IS NOT NULL
  AND name IN ('Revisión y Formato', 'Apostilla en Cancillería', 'Formularios Dirección General de Migración');

UPDATE service_catalog SET foja_tipo = 'modificacion', fojas = COALESCE(fojas, 1), unit_type = 'por documento'
WHERE name = 'Modificación de Documento Existente';

UPDATE service_catalog SET foja_tipo = 'carta_motivada', fojas = COALESCE(fojas, 1), unit_type = 'por documento'
WHERE name IN ('Notificación Sencilla', 'Notificación Avanzada', 'Notificación Personalizada');

UPDATE service_catalog SET foja_tipo = 'legal_motivada'
WHERE foja_tipo = 'legal_simple' AND name ILIKE '%notoriedad%';

SELECT 'Migration 20261018_partidas_por_confirmar completed successfully' AS status;
