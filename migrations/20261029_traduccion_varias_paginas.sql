-- ============================================================
-- Captura 04 de Leandro: un libro de matrimonio en sueco de 5 hojas → "desde RD$800 por página". El bot tomaba el
-- acta extranjera (RD$1,000 por documento) y la multiplicaba por página, porque su regla decía "se cobra por página".
-- El acta extranjera es por documento; un documento extranjero de varias páginas va por "Varias Páginas" (por página).
-- Idempotente.
-- ============================================================
UPDATE service_catalog SET reglas =
  'Se cobra por documento: es para un acta (nacimiento, matrimonio, defunción…) de una sola página. Si el documento extranjero tiene varias páginas (un libro de familia o de matrimonio, un contrato, un expediente), use "Traducción - Varias Páginas, Solo Texto (Documento Extranjero)", que se cobra por página. Solo se traduce la versión final y oficial que entrega el cliente. Envíe el documento en foto o PDF para cotizar. Suele acompañarse del servicio de apostilla.'
WHERE name = 'Traducción - Acta Extranjera al Español';

UPDATE service_catalog SET
  reglas = 'Es un precio "desde": se cobra por página y puede subir según el formato y la cantidad de caracteres; el digitador confirma el monto final. Diga el número de páginas y el precio por página. Solo se traduce la versión final y oficial que entrega el cliente. Envíe el documento en foto o PDF para cotizar.',
  alias = ARRAY(SELECT DISTINCT unnest(COALESCE(alias, '{}') || ARRAY['libro de matrimonio', 'libro de familia',
    'documento extranjero de varias paginas', 'traducir documento extranjero', 'traduccion de varias paginas']))
WHERE name = 'Traducción - Varias Páginas, Solo Texto (Documento Extranjero)';

SELECT 'Migration 20261029_traduccion_varias_paginas completed successfully' AS status;
