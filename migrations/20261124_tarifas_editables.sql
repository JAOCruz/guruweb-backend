-- ============================================================
-- Tarifas editables (Leandro, 2026-11-24)
--   1. pricing_rates: tarifas por foja y de traducción que el admin cambia desde el dashboard. El bot las lee.
--   2. doc_templates.fojas / foja_tipo: el precio de cada modelo = fojas × tarifa (se calcula al leer).
--   3. Traducciones: nueva «ley» de precios. Tres tipos por tamaño y densidad, con precio por página que baja
--      con la cantidad: 1-2 páginas, 3-9 páginas, 10 o más. Total = precio del tramo × páginas.
--      Los 12 servicios de traducción anteriores quedan inactivos (no se borran) como constancia de cómo era antes.
-- Idempotente.
-- ============================================================

CREATE TABLE IF NOT EXISTS pricing_rates (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_by INT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO pricing_rates (key, value) VALUES
  ('foja', '{"carta_simple":150,"carta_motivada":300,"legal_simple":250,"legal_motivada":350,"modificacion":150}'),
  ('traduccion', '{"tipos":[
     {"key":"carta_sencillo","label":"Carta sencillo","tramos":[{"desde":1,"precio":700},{"desde":3,"precio":600},{"desde":10,"precio":500}]},
     {"key":"carta_denso","label":"Carta extensivo o denso","tramos":[{"desde":1,"precio":1000},{"desde":3,"precio":800},{"desde":10,"precio":700}]},
     {"key":"legal_denso","label":"Legal extensivo o denso","tramos":[{"desde":1,"precio":800},{"desde":3,"precio":700},{"desde":10,"precio":600}]}
   ]}')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE IF EXISTS doc_templates ADD COLUMN IF NOT EXISTS fojas INT;
ALTER TABLE IF EXISTS doc_templates ADD COLUMN IF NOT EXISTS foja_tipo TEXT;

ALTER TABLE service_catalog ADD COLUMN IF NOT EXISTS traduccion_tipo TEXT;

-- Antes de crear los nuevos: los viejos (sin traduccion_tipo) quedan inactivos.
UPDATE service_catalog SET active = false
WHERE name ILIKE 'Traducción - %' AND traduccion_tipo IS NULL AND active = true;

INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, por_confirmar, notarizacion, traduccion_tipo, descripcion, reglas, alias)
SELECT v.name, (SELECT id FROM service_categories WHERE name ILIKE '%traducci%' ORDER BY id LIMIT 1),
       v.precio, 'por página', true, false, 'no_aplica', v.tipo, v.descripcion, v.reglas, v.alias
FROM (VALUES
  ('Traducción - Carta sencillo', 'carta_sencillo', 700,
   'Documento tamaño carta con poco texto: certificaciones (no antecedentes penales, Fiscalía, JCE), constancias, actas de una página, comprobantes de cita.',
   'Tamaño carta, tipo sencillo: poco texto, párrafos cortos y mucho espacio en blanco (certificaciones, constancias, actas, comprobantes). Se cobra por página y el precio por página baja con la cantidad de páginas: el total es el precio del tramo por todas las páginas. Pida el documento en foto o PDF para ver cuántas páginas son. Solo se traduce la versión final y oficial. El digitador confirma el tipo y el precio.',
   ARRAY['traduccion', 'traducir', 'traduccion sencilla', 'traducir certificado', 'traducir acta', 'traducir certificacion', 'traduccion de no antecedentes', 'traducir constancia', 'traduccion al ingles', 'traduccion al español']),
  ('Traducción - Carta extensivo o denso', 'carta_denso', 1000,
   'Documento tamaño carta lleno de texto, tablas o campos: récord de notas, exámenes médicos, actas extranjeras con formulario, estados de cuenta.',
   'Tamaño carta, tipo extensivo o denso: la página está llena de texto, tablas o campos con letra pequeña (récord de notas, exámenes médicos, actas o certificados extranjeros con formulario). Se cobra por página y el precio por página baja con la cantidad de páginas: el total es el precio del tramo por todas las páginas. Pida el documento en foto o PDF. Solo se traduce la versión final y oficial. El digitador confirma el tipo y el precio.',
   ARRAY['traduccion densa', 'traducir record de notas', 'traducir examen medico', 'traducir acta de defuncion', 'traduccion extensa', 'traducir documento extranjero', 'traducir notas', 'traducir formulario']),
  ('Traducción - Legal extensivo o denso', 'legal_denso', 800,
   'Documento tamaño legal (8.5×14) con texto corrido: actos notariales, declaraciones juradas, poderes, contratos.',
   'Tamaño legal (8.5×14), extensivo o denso: actos notariales, declaraciones juradas, poderes o contratos con texto corrido de borde a borde. Se cobra por página y el precio por página baja con la cantidad de páginas: el total es el precio del tramo por todas las páginas. Pida el documento en foto o PDF. Solo se traduce la versión final y oficial. El digitador confirma el tipo y el precio.',
   ARRAY['traducir acto notarial', 'traducir declaracion jurada', 'traducir poder', 'traducir contrato', 'traduccion legal', 'traducir acto'])
) AS v(name, tipo, precio, descripcion, reglas, alias)
WHERE NOT EXISTS (SELECT 1 FROM service_catalog s WHERE s.name = v.name);

SELECT 'Migration 20261124_tarifas_editables completed successfully' AS status;
