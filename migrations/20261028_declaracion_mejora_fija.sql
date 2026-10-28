-- Captura 07 de Leandro: la declaración jurada de mejora (1 página) se cobra RD$500 de redacción, no por foja
-- (con la foja salía en 250 + 1,000). Redacción fija 500 + notarización 1,000 = 1,500. Idempotente.
UPDATE service_catalog SET foja_tipo = NULL, digitacion_price = 500, notarizacion_price = 1000
WHERE name IN ('Declaración Jurada - Mejora Const. Estado', 'Declaración Jurada - Mejora Const. Particulares');
SELECT 'Migration 20261028_declaracion_mejora_fija completed successfully' AS status;
