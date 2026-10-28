-- ============================================================
-- Precios de las capturas de Leandro (docs/bot-ia/ejemplos-leandro). Jay, 2026-10-28: "si algo difiere de la
-- base de datos usa los screenshots" y anota la diferencia para que Leandro la confirme (PDF de pruebas del bot).
--   14  Tarifas (solo) de notarización de contratos traslativos (vehículos, inmuebles y demás bienes):
--       0-150 mil 500 · 150-500 mil 700 · 500 mil-1 millón 1,000 · 1-3 millones 2,000 · 3-5 millones 4,000 ·
--       5-8 millones 8,000 (más de 8 millones: por confirmar).        Antes: 0-100 mil 500 · 100-800 mil 700 ·
--       800 mil-1 millón 1,000 · 1-3 millones 2,000 · 3-5 millones 3,000 · más de 5 millones 5,000.
--   03  Acto de venta de vehículo, formato sencillo: redacción 500 (2 fojas). Antes 250 (1 foja).
--   15  Poder sencillo 1,000 (redacción 300 + notarización 700; la 05 cobra 700 la notarización sola). Antes 950.
--       Poder avanzado desde 2,000 (nuevo).
--   07  Declaración jurada de mejora: solo redacción 500; con notarización 1,500. Antes 250 + 700.
--   04  Traducción de un documento extranjero de varias páginas: desde 800 por página. Antes 700.
--   08  Factura (hacerla o rehacerla): 250. Antes se cotizaba como modificación (150 por página).
-- Idempotente.
-- ============================================================

UPDATE service_catalog SET price_tiers = '[
  {"label": "Hasta RD$150K", "min": 0, "max": 150000, "price": 500},
  {"label": "RD$150K-500K", "min": 150001, "max": 500000, "price": 700},
  {"label": "RD$500K-1M", "min": 500001, "max": 1000000, "price": 1000},
  {"label": "RD$1M-3M", "min": 1000001, "max": 3000000, "price": 2000},
  {"label": "RD$3M-5M", "min": 3000001, "max": 5000000, "price": 4000},
  {"label": "RD$5M-8M", "min": 5000001, "max": 8000000, "price": 8000}
]'::jsonb
WHERE (name LIKE 'Acto de Venta - %' OR name LIKE 'Acto de Venta Condicional - %' OR name = 'Contrato de Venta Bienes')
  AND jsonb_array_length(COALESCE(price_tiers, '[]'::jsonb)) > 0;

UPDATE service_catalog SET fojas = 2, foja_tipo = 'legal_simple' WHERE name = 'Acto de Venta - Vehículo Liviano';

UPDATE service_catalog SET foja_tipo = NULL, digitacion_price = 300, notarizacion_price = 700
WHERE name = 'Poder Especial de Autorización (Sencillo)';

INSERT INTO service_catalog (name, category_id, digitacion_price, notarizacion_price, unit_type, active, por_confirmar, notarizacion, fojas, descripcion, reglas, alias)
SELECT 'Poder Especial de Autorización (Avanzado)',
       (SELECT category_id FROM service_catalog WHERE name = 'Poder Especial de Autorización (Extensivo)' LIMIT 1),
       500, 1500, 'por documento', true, false, 'opcional', 2,
       'Poder especial de formato avanzado (varias facultades o gestiones complejas), redacción y firma de notario.',
       'Es un precio "desde": puede subir según la extensión y las facultades del poder; el digitador confirma el monto final. Pregunte para qué fines es el poder.',
       ARRAY['poder avanzado', 'poder especial avanzado']
WHERE NOT EXISTS (SELECT 1 FROM service_catalog WHERE name = 'Poder Especial de Autorización (Avanzado)');

UPDATE service_catalog SET fojas = 2, foja_tipo = 'legal_simple', notarizacion_price = 1000
WHERE name IN ('Declaración Jurada - Mejora Const. Estado', 'Declaración Jurada - Mejora Const. Particulares');

UPDATE service_catalog SET digitacion_price = 800 WHERE name = 'Traducción - Varias Páginas, Solo Texto (Documento Extranjero)';

INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, por_confirmar, notarizacion, descripcion, reglas, alias)
SELECT 'Factura (digitación)',
       (SELECT id FROM service_categories WHERE name = 'Redactar o digitar un documento' LIMIT 1),
       250, 'por documento', true, false, 'no_aplica',
       'Hacer o rehacer una factura con el formato que trae el cliente.',
       'Incluye las modificaciones que pida, una revisión extensiva en busca de errores e inconsistencias y una impresión del documento; lo hace un profesional. Si solo hay que cambiar un dato de un documento que ya tiene en Word, es una modificación.',
       ARRAY['factura', 'hacer una factura', 'rehacer factura', 'digitar factura', 'cambiar fecha de factura']
WHERE NOT EXISTS (SELECT 1 FROM service_catalog WHERE name = 'Factura (digitación)');

SELECT 'Migration 20261028_precios_capturas completed successfully' AS status;
