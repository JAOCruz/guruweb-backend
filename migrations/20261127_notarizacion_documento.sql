-- ============================================================
-- Captura 21 de Leandro (2026-11-27): solo notarizar un documento que el cliente ya trae y que no es una venta
-- (contrato de arrendamiento, declaración jurada, carta…): RD$700. El precio admite hasta 2 originales o copias
-- por documento; desde el tercero, cada uno es duplicado. Las ventas siguen en "Notarización de Contrato
-- (solo notarizar)", por el valor del bien. Idempotente.
-- ============================================================
INSERT INTO service_catalog (name, category_id, digitacion_price, notarizacion_price, unit_type, active, por_confirmar, notarizacion, fojas, descripcion, incluye, reglas, alias)
SELECT 'Notarización de Documento (solo notarizar)',
       (SELECT id FROM service_categories WHERE name = 'Notarización' LIMIT 1),
       0, 700, 'por documento', true, false, 'obligatoria', 1,
       'Notarizar un documento que el cliente ya trae redactado y que no es una venta: contrato de arrendamiento o alquiler, declaración jurada, carta, acuerdo, etc.',
       'Revisión del documento; firma y sello de un abogado notario público; hasta 2 originales o copias por documento. Si no está firmado, se imprime y las partes firman ante el notario.',
       'Precio por documento: cotice cada documento por separado (cantidad = número de documentos de este tipo). Incluye hasta 2 originales o copias por documento; si quiere más de 2, pase en duplicados solo los que pasen de 2. Por lo general no importa si el documento ya está firmado. Si es una venta (vehículo, inmueble u otro bien), use "Notarización de Contrato (solo notarizar)", que va por el valor del bien.',
       ARRAY['notarizar documento', 'notarizar declaracion jurada', 'notarizar declaraciones juradas', 'notarizar contrato de arrendamiento',
             'notarizar contrato de alquiler', 'notarizar arrendamiento', 'notarizar carta', 'notarizar acuerdo', 'solo notarizar documento']
WHERE NOT EXISTS (SELECT 1 FROM service_catalog WHERE name = 'Notarización de Documento (solo notarizar)');

SELECT 'Migration 20261127_notarizacion_documento completed successfully' AS status;
