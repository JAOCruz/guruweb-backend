-- ============================================================
-- Respuestas de Leandro (correos del 2026-10-26)
--   1. Políticas del negocio (imagen DISCLAIMERS): el bot las tiene en su contexto
--   2. Pagaré notarial: redacción + notarización desde RD$1,500 (500 + notarización 1,000);
--      solo redacción RD$500; solo notarización desde RD$1,000; el modelo (plantilla) RD$300.
--      Los montos van en las columnas de precio; el texto de las reglas no lleva montos.
--   3. Acto de venta de vehículo: si nadie mencionó un apoderado, preguntar si desea incluir uno
--   4. Seguimiento de cotizaciones: un día sin respuesta → un mensaje de seguimiento (encendido)
-- Solo toca esas filas y frases. Idempotente: se puede correr varias veces.
-- ============================================================

-- 1. Políticas
INSERT INTO business_info (clave, valor, updated_at) VALUES ('politicas', $j$[
  "Solo trabajamos con la información suministrada por el cliente; cualquier error que no sea reportado antes de la aprobación definitiva requerirá un RE-PROCESAMIENTO de la notarización, lo cual generará costos adicionales.",
  "Los retrasos en los trámites que dependen exclusivamente de los tiempos de respuesta, caídas de sistema o procesos burocráticos de instituciones públicas u oficinas de terceros están totalmente fuera de nuestro control. No nos hacemos responsables por rechazos en instituciones gubernamentales debido a información incorrecta o incompleta proporcionada por el usuario.",
  "No somos un bufete de abogados litigantes y no ofrecemos representación legal directa ante los tribunales. La responsabilidad sobre el fondo legal, el uso y las consecuencias de las instancias, contratos o actos notariales procesados recae enteramente en el cliente o en su abogado representante.",
  "Tenemos una Política de Confidencialidad estricta: no conservamos documentaciones personales como cédulas, actas, títulos, entre otros, suministradas de manera física ni digital; no retenemos documentos originales por más tiempo del estrictamente necesario para su procesamiento."
]$j$::jsonb, NOW())
ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW();

-- 2. Pagaré notarial: notarización desde RD$1,000 y el precio "desde" (las variantes Sencillo/Avanzado/Extensivo no se tocan)
UPDATE service_catalog SET
  notarizacion_price = 1000,
  reglas = CONCAT_WS(' ', NULLIF(reglas, ''),
    'Precios del pagaré: la redacción + notarización y la notarización sola son precios "desde" (en adelante): pueden subir según el volumen, el monto o la extensión de la redacción, y el digitador confirma el monto final. Dé las tres opciones con calcular_precio: redacción + notarización, solo redacción y solo notarización. Si el cliente solo quiere el modelo (plantilla) para llenarlo él mismo, es el servicio "Pagaré Notarial - Modelo (plantilla)".')
WHERE name = 'Pagaré Notarial'
  AND COALESCE(reglas, '') NOT LIKE '%Precios del pagaré:%';

INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, por_confirmar, notarizacion, descripcion, reglas, alias)
SELECT 'Pagaré Notarial - Modelo (plantilla)',
       (SELECT id FROM service_categories WHERE name = 'Redactar o digitar un documento' LIMIT 1),
       300, 'por documento', true, false, 'no_aplica',
       'El modelo en Word del pagaré notarial para que el cliente lo llene.',
       'Es solo el modelo: no incluye redacción con los datos del cliente ni notarización.',
       ARRAY['modelo de pagare', 'plantilla de pagare', 'template de pagare']
WHERE NOT EXISTS (SELECT 1 FROM service_catalog WHERE name = 'Pagaré Notarial - Modelo (plantilla)');

-- 3. Venta de vehículo: el apoderado
UPDATE service_catalog SET
  reglas = CONCAT_WS(' ', NULLIF(reglas, ''),
    'Antes de pasar la cuenta o cerrar el pedido, si nadie ha mencionado un apoderado, pregunte si desea incluir uno al contrato: una persona autorizada por si el VENDEDOR o el COMPRADOR no pueden ir a realizar el traspaso. Si ya lo mencionaron o lo agregaron, no lo pregunte. Con apoderado se usa el modelo ACTO DE VENTA DE VEHICULO - CON APODERADO.')
WHERE name ILIKE '%venta%veh%'
  AND COALESCE(reglas, '') NOT LIKE '%si nadie ha mencionado un apoderado%';

-- 4. Seguimiento de cotizaciones: encendido, a las 24 h (si el admin ya lo cambió, se respeta)
INSERT INTO business_info (clave, valor, updated_at) VALUES ('seguimiento_cotizaciones', '{"activo": true, "horas": 24}'::jsonb, NOW())
ON CONFLICT (clave) DO NOTHING;

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS followup_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS followup_error TEXT;

SELECT 'Migration 20261027_politicas_seguimiento completed successfully' AS status;
