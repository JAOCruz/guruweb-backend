-- ============================================================
-- Captura 14 de Leandro: notarizar un contrato que el cliente ya trae redactado (venta de vehículo, inmueble,
-- promesa de venta…). Tarifas (solo) de notarización según el valor del bien; incluye revisión extensiva,
-- notario sin tachas y un solo original (los demás son duplicados). Idempotente.
-- ============================================================
INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, por_confirmar, notarizacion, price_tiers, descripcion, incluye, reglas, alias)
SELECT 'Notarización de Contrato (solo notarizar)',
       (SELECT id FROM service_categories WHERE name = 'Notarización' LIMIT 1),
       0, 'por documento', true, false, 'obligatoria',
       '[{"label": "Hasta RD$150K", "min": 0, "max": 150000, "price": 500},
         {"label": "RD$150K-500K", "min": 150001, "max": 500000, "price": 700},
         {"label": "RD$500K-1M", "min": 500001, "max": 1000000, "price": 1000},
         {"label": "RD$1M-3M", "min": 1000001, "max": 3000000, "price": 2000},
         {"label": "RD$3M-5M", "min": 3000001, "max": 5000000, "price": 4000},
         {"label": "RD$5M-8M", "min": 5000001, "max": 8000000, "price": 8000}]'::jsonb,
       'Notarizar un contrato traslativo (venta de vehículo, inmueble, promesa de venta y demás bienes) que el cliente ya trae redactado.',
       'Revisión extensiva del documento en busca de errores u inconsistencias; un notario libre de tachas y excepciones de ley; un solo original (si necesita más, los demás son duplicados).',
       'El precio depende del valor del bien: pregúntelo, o si no lo sabe dé las tarifas por tramo con calcular_precio. Explique lo que incluye. Si necesita varios ejemplares, uno es el original y los demás son duplicados (calcular_precio con duplicados).',
       ARRAY['solo notarizar', 'solo notarizacion', 'notarizar contrato', 'notarizar un contrato', 'sellar ejemplares', 'notarizar promesa de venta', 'notarizar acto de venta']
WHERE NOT EXISTS (SELECT 1 FROM service_catalog WHERE name = 'Notarización de Contrato (solo notarizar)');

SELECT 'Migration 20261028_notarizacion_contratos completed successfully' AS status;
