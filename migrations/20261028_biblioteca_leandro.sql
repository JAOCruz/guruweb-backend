-- ============================================================
-- Biblioteca de modelos de Leandro (MOTHER BRAIN RPG, 2026-10-27) y demandas
--   1. Las versiones de modelo pueden venir de la biblioteca ('library'): las etiquetas las puso Leandro
--      y se aprueban tal cual (las carga scripts/importar-biblioteca.js).
--   2. Demandas: documentación motivada, por foja (tarifa carta_motivada). Leandro, 2026-10-28:
--      "esas son documentaciones motivadas, las que cuestan por fojas". Los recursos y los actos de
--      alguacil ya están en el catálogo con esa tarifa.
-- Idempotente: se puede correr varias veces.
-- ============================================================

ALTER TABLE template_tag_versions DROP CONSTRAINT IF EXISTS template_tag_versions_source_check;
ALTER TABLE template_tag_versions ADD CONSTRAINT template_tag_versions_source_check
  CHECK (source IN ('ai', 'edit', 'restore', 'client', 'library'));

INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, por_confirmar, notarizacion,
                             foja_tipo, fojas, descripcion, reglas, alias)
SELECT 'Demanda',
       (SELECT id FROM service_categories WHERE name = 'Redactar o digitar un documento' LIMIT 1),
       300, 'por documento', true, false, 'no_aplica', 'carta_motivada', 1,
       'Redacción de una demanda (civil, laboral, de familia, inmobiliaria, desalojo, cobro…): documentación motivada.',
       'Es documentación motivada: se cobra por foja. El número de fojas depende del caso y lo confirma el digitador al ver la información; dé el precio como "por foja" y no prometa un total. Requisitos: tipo de demanda, datos de las partes (demandante y demandado), tribunal si lo sabe, los hechos y los documentos que la sustentan.',
       ARRAY['demanda', 'demandar', 'redactar una demanda', 'demanda laboral', 'demanda de divorcio', 'demanda en cobro', 'demanda de desalojo', 'demanda civil']
WHERE NOT EXISTS (SELECT 1 FROM service_catalog WHERE name = 'Demanda');

SELECT 'Migration 20261028_biblioteca_leandro completed successfully' AS status;
