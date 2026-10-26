-- ============================================================
-- Apostilla en Cancillería (respuesta de Leandro, 2026-10-26)
--   - es una gestión: solicitamos la apostilla por el cliente; no elaboramos el documento
--   - se cotiza uno o varios impuestos, según el caso
--   - la Cancillería responde en 8 a 24 horas laborables
-- Solo toca esas frases; el resto de lo editado en el dashboard se queda igual.
-- Idempotente: se puede correr varias veces.
-- ============================================================

UPDATE service_catalog SET
  descripcion = 'Gestión de la solicitud de apostilla en la Cancillería (MIREX) para usar un documento en el extranjero.',
  tiempo_entrega = 'De 8 a 24 horas laborables, lo que tarda la Cancillería en responder',
  reglas = CONCAT_WS(' ', NULLIF(reglas, ''),
    'Es una gestión: solicitamos la apostilla en la Cancillería por el cliente; no elaboramos el documento. Se cotiza uno o varios impuestos según el caso (el del MIREX es por documento y, si el documento es notarial, se suma el de legalización en la Procuraduría). La Cancillería responde en 8 a 24 horas laborables.')
WHERE name = 'Apostilla en Cancillería'
  AND COALESCE(reglas, '') NOT LIKE '%Es una gestión: solicitamos la apostilla%';

UPDATE tramites SET reglas = REPLACE(reglas,
  'la Cancillería suele responder en 24 horas o más, según el estado de los documentos',
  'la Cancillería responde en 8 a 24 horas laborables, según el estado de los documentos')
WHERE nombre IN ('Apostilla de documento', 'Apostilla de certificación');

UPDATE business_info SET
  valor = valor || '[{"servicio": "Apostilla en Cancillería", "tiempo": "de 8 a 24 horas laborables", "nota": "es lo que tarda la Cancillería en responder"}]'::jsonb,
  updated_at = NOW()
WHERE clave = 'tiempos_entrega' AND jsonb_typeof(valor) = 'array'
  AND NOT valor @> '[{"servicio": "Apostilla en Cancillería"}]'::jsonb;

SELECT 'Migration 20261026_apostilla_cancilleria completed successfully' AS status;
