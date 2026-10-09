-- Correcciones de precios de Leandro, ronda 1. Idempotente: se puede correr varias veces.

-- 1. Fojas: tipo de foja y fojas estimadas por servicio
ALTER TABLE service_catalog
  ADD COLUMN IF NOT EXISTS foja_tipo TEXT,
  ADD COLUMN IF NOT EXISTS fojas INTEGER;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_catalog_foja_tipo_check') THEN
    ALTER TABLE service_catalog ADD CONSTRAINT service_catalog_foja_tipo_check
      CHECK (foja_tipo IS NULL OR foja_tipo IN ('carta_simple','carta_motivada','legal_simple','legal_motivada'));
  END IF;
END $$;

-- 2. Caché de tasas estimadas
CREATE TABLE IF NOT EXISTS tasas_cache (
  id SERIAL PRIMARY KEY,
  concepto_key TEXT UNIQUE NOT NULL,
  concepto TEXT,
  monto NUMERIC,
  fuente TEXT,
  nota TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Conflictos resueltos: quita "por confirmar" y la nota del seed
UPDATE service_catalog SET
  por_confirmar = false,
  reglas = NULLIF(btrim(regexp_replace(coalesce(reglas, ''), '\n?Precio por confirmar:.*?Leandro confirma\.\s*', '', 'g'), E'\n '), '')
WHERE name = 'Certificación Estatus Jurídico Inmueble'
   OR name LIKE 'Instancia%'
   OR name IN ('Estatutos Sociales', 'Nómina de Pagos/Presencia', 'Foto 2x2', 'Fotocopia 11x17"');

UPDATE service_catalog
SET reglas = CASE WHEN coalesce(reglas, '') = '' THEN 'No incluye impuestos.' ELSE reglas || E'\nNo incluye impuestos.' END
WHERE name = 'Certificación Estatus Jurídico Inmueble'
  AND position('No incluye impuestos' in coalesce(reglas, '')) = 0;

UPDATE service_catalog SET digitacion_price = 250, unit_type = 'por juego de hasta 5 fotos'
WHERE name = 'Foto 2x2';

UPDATE service_catalog SET digitacion_price = 50 WHERE name = 'Fotocopia 11x17"';
UPDATE service_catalog
SET reglas = CASE WHEN coalesce(reglas, '') = '' THEN 'A color: RD$100.' ELSE reglas || E'\nA color: RD$100.' END
WHERE name = 'Fotocopia 11x17"'
  AND position('RD$100' in coalesce(reglas, '')) = 0;

-- 4. Actos de venta: sin tramos por confirmar; Contrato de Venta Bienes usa la tabla A
UPDATE service_catalog
SET price_tiers = (SELECT jsonb_agg(t - 'por_confirmar' ORDER BY ord) FROM jsonb_array_elements(price_tiers) WITH ORDINALITY AS x(t, ord))
WHERE name LIKE 'Acto de Venta%'
  AND price_tiers IS NOT NULL AND jsonb_typeof(price_tiers) = 'array' AND jsonb_array_length(price_tiers) > 0;

UPDATE service_catalog SET price_tiers = '[
  {"min":0,"max":100000,"price":500,"label":"Hasta RD$100K"},
  {"min":100001,"max":800000,"price":700,"label":"RD$100K-800K"},
  {"min":800001,"max":1000000,"price":1000,"label":"RD$800K-1M"},
  {"min":1000001,"max":3000000,"price":2000,"label":"RD$1M-3M"},
  {"min":3000001,"max":5000000,"price":3000,"label":"RD$3M-5M"},
  {"min":5000001,"max":null,"price":5000,"label":"RD$5M+"}
]'::jsonb
WHERE name = 'Contrato de Venta Bienes';

-- 5. Mensajería: trámites a 1,000 por documento, sin impuestos
UPDATE service_catalog SET
  digitacion_price = 1000, unit_type = 'por documento', por_confirmar = false,
  reglas = NULLIF(btrim(regexp_replace(coalesce(reglas, ''), 'Precio por confirmar con el digitador \([^)]*\)\.\s*|El precio depende del mensajero y de la distancia; los impuestos y tasas del Estado los paga el cliente y no son parte del precio\.\s*', '', 'g'), E'\n '), '')
WHERE name IN ('Mensajería - Legalización en Procuraduría', 'Mensajería - Depósito de Traspaso en DGII', 'Mensajería - Solicitud de Certificación');

UPDATE service_catalog
SET reglas = CASE WHEN coalesce(reglas, '') = '' THEN 'No incluye impuestos.' ELSE reglas || ' No incluye impuestos.' END
WHERE name IN ('Mensajería - Legalización en Procuraduría', 'Mensajería - Depósito de Traspaso en DGII', 'Mensajería - Solicitud de Certificación')
  AND position('No incluye impuestos' in coalesce(reglas, '')) = 0;

UPDATE service_catalog
SET reglas = CASE WHEN coalesce(reglas, '') = '' THEN 'Precio pendiente de Leandro.' ELSE reglas || ' Precio pendiente de Leandro.' END
WHERE name IN ('Mensajería - Depósito de Documentos en Migración', 'Mensajería - Registro en Ayuntamiento', 'Mensajería - Recolección de Firmas')
  AND position('pendiente de Leandro' in coalesce(reglas, '')) = 0;

-- Servicios nuevos de mensajería, a 1,000 por documento
INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, por_confirmar, notarizacion, reglas)
SELECT v.name, (SELECT id FROM service_categories WHERE name = 'Mensajería' LIMIT 1),
       1000, 'por documento', true, false, 'no_aplica', 'No incluye impuestos.'
FROM (VALUES
  ('Mensajería - Depósito en Cámara de Comercio'),
  ('Mensajería - Cancillería (MIREX)'),
  ('Mensajería - Ministerio de Educación'),
  ('Mensajería - MESCYT')
) AS v(name)
WHERE NOT EXISTS (SELECT 1 FROM service_catalog s WHERE s.name = v.name);

-- Envío al cliente: lo que cobre Uber, por confirmar
UPDATE service_catalog SET
  name = 'Envío al cliente (Uber)',
  digitacion_price = NULL, por_confirmar = true, notarizacion = 'no_aplica',
  reglas = 'Solo para documentos que hicimos o modificamos nosotros. Se cobra lo que marque Uber; el monto se confirma al momento del envío.'
WHERE name = 'Mensajería Local (Santo Domingo)';

UPDATE service_catalog
SET alias = array_append(coalesce(alias, '{}'), 'mensajería local')
WHERE name = 'Envío al cliente (Uber)' AND NOT ('mensajería local' = ANY (coalesce(alias, '{}')));

-- 6. Originales adicionales o duplicados
INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, por_confirmar, notarizacion)
SELECT v.name, (SELECT id FROM service_categories WHERE name = 'Redactar o digitar un documento' LIMIT 1),
       v.price, 'por original', true, false, 'no_aplica'
FROM (VALUES
  ('Original adicional o duplicado (1 o 2 fojas)', 500),
  ('Original adicional o duplicado (3 o más fojas)', 700)
) AS v(name, price)
WHERE NOT EXISTS (SELECT 1 FROM service_catalog s WHERE s.name = v.name);

-- 7. Originales: por defecto 1; 2 solo en alquileres sencillos
UPDATE service_catalog SET reglas = regexp_replace(reglas,
  '(El abogado notario firma hasta 2 originales; los demás van como duplicados\.|Máximo 2 originales firmados por el notario; los demás van como duplicados\.)',
  'Incluye 2 originales; cada original adicional o duplicado se cobra aparte.', 'g')
WHERE (name ~ '^Contrato de Alquiler.*Sencillo' OR name = 'Contrato de Alquileres o Renta Inmueble (Sencillo)')
  AND reglas ~ '(El abogado notario firma hasta 2 originales|Máximo 2 originales firmados por el notario); los demás van como duplicados\.';

UPDATE service_catalog SET reglas = regexp_replace(reglas,
  '(El abogado notario firma hasta 2 originales; los demás van como duplicados\.|Máximo 2 originales firmados por el notario; los demás van como duplicados\.)',
  'Incluye 1 original; cada original adicional o duplicado se cobra aparte.', 'g')
WHERE reglas ~ '(El abogado notario firma hasta 2 originales|Máximo 2 originales firmados por el notario); los demás van como duplicados\.';
