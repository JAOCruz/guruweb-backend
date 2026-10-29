-- ============================================================
-- Leandro, 2026-10-29 (fix de la captura 02): hay dos certificaciones de vehículo y la gente las confunde.
--   · Básica: verificación de vehículo en la Policía Nacional o el CERNAVE (RD$500 + impuestos). Es la que sirve en
--     la mayoría de los casos, incluso para el traspaso en la DGII.
--   · Verificación de Vehículo para fines de Traspaso (DGII): RD$1,000 + impuestos, opcional y más avanzada: es como
--     una cita para agilizar el traspaso, con seguimiento en línea subiendo los documentos y terminando en la DGII;
--     igual hay que llevar el vehículo.
-- El bot pregunta cuál de las dos quiere. La cita se pide con 24 a 48 horas, pero no literal: la institución solo
-- exige tener la cita hecha; el cliente puede pasar a partir de las 12 o la 1, o a la hora acordada.
-- Idempotente.
-- ============================================================
UPDATE service_catalog SET
  descripcion = 'Verificación básica del vehículo en la Policía Nacional o el CERNAVE (Plan Piloto): gestión de la cita y la certificación.',
  reglas = 'Hay dos certificaciones de vehículo y la gente las confunde. Si el cliente no dijo cuál, pregunte primero: ¿solo la certificación por verificación en la Policía Nacional o el CERNAVE (esta, la básica), o el proceso más avanzado, la "Verificación de Vehículo para fines de Traspaso (DGII)"? Puede dar los dos precios. La básica es la estándar y sirve en la mayoría de los casos, también para el traspaso en la DGII. El precio es el de la gestión; el impuesto de la certificación va aparte y lo confirma el digitador: dígalo así ("más el impuesto"). En el mismo mensaje del precio pida la cédula del propietario del vehículo (de ambos lados), la matrícula del vehículo y cuándo le gustaría la cita para llevar el vehículo; no confirme la cita usted: la agenda el equipo. La cita se pide con 24 a 48 horas de antelación, pero no es literal: la institución solo exige tener la cita hecha, y el cliente puede pasar a partir de las 12 o la 1 de la tarde, o a la hora acordada. Las instituciones responden solo en días laborables.',
  alias = ARRAY(SELECT DISTINCT unnest(COALESCE(alias, '{}') || ARRAY['verificacion de vehiculo', 'verificacion de vehiculos',
    'cernave', 'certificacion de la policia', 'verificacion policia nacional', 'certificacion de vehiculo para traspaso']))
WHERE name = 'Certificación de Vehículo (Plan Piloto)';

INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, por_confirmar, notarizacion,
                             descripcion, requisitos, reglas, alias)
SELECT 'Verificación de Vehículo para fines de Traspaso (DGII)',
       (SELECT id FROM service_categories WHERE name = 'Solicitud de Certificaciones' LIMIT 1),
       1000, 'por vehículo', true, false, 'no_aplica',
       'Verificación de vehículo para fines de traspaso ante la DGII: cita para agilizar el traspaso, con seguimiento en línea subiendo los documentos.',
       'Cédula del propietario del vehículo (de ambos lados) y la matrícula del vehículo; el digitador confirma si hace falta algo más.',
       'Es opcional y más avanzada que la verificación básica (Policía Nacional o CERNAVE): es como una cita para agilizar el traspaso ante la DGII, con seguimiento en línea subiendo los documentos, y se concluye yendo a la DGII. Igual hay que llevar el vehículo, así que el proceso es básicamente el mismo; la mayoría resuelve con la básica. Si el cliente no dijo cuál quiere, pregunte cuál de las dos y puede dar los dos precios. El precio es el de la gestión; los impuestos van aparte y los confirma el digitador ("más los impuestos"). La cita se pide con 24 a 48 horas de antelación, pero no es literal: basta con tener la cita hecha; no confirme la cita usted, la agenda el equipo.',
       ARRAY['verificacion para traspaso', 'verificacion de vehiculo para traspaso', 'verificacion vehiculo dgii',
             'certificacion para traspaso dgii', 'cita dgii traspaso']
WHERE NOT EXISTS (SELECT 1 FROM service_catalog WHERE name = 'Verificación de Vehículo para fines de Traspaso (DGII)');

SELECT 'Migration 20261029_verificacion_vehiculo completed successfully' AS status;
