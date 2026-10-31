-- ============================================================
-- Jay, 2026-10-31: los digitadores envían los documentos de sus clientes (y los que ellos hicieron) sin que el
-- admin los apruebe; lo que aprueba el admin son las versiones nuevas de los modelos. Se enciende el switch
-- «Los digitadores pueden aprobar y enviar documentos» (Configuración); el admin lo puede apagar ahí. Corre una vez.
-- ============================================================
INSERT INTO business_info (clave, valor, updated_at) VALUES ('digitadores_aprueban_documentos', 'true'::jsonb, NOW())
ON CONFLICT (clave) DO UPDATE SET valor = 'true'::jsonb, updated_at = NOW();

SELECT 'Migration 20261031_digitadores_envian completed successfully' AS status;
