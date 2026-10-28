-- ============================================================
-- Certificación de vehículo en Plan Piloto (captura 02 de Leandro): "El servicio tiene un costo de $500 +
-- el impuesto, y necesitamos: cédula del propietario del vehículo (de ambos lados), matrícula del vehículo
-- en cuestión y cuándo le gustaría agendar la cita para llevar el vehículo".
-- El precio de la columna es la gestión; el impuesto de la institución va aparte y lo confirma el digitador.
-- Idempotente.
-- ============================================================
INSERT INTO service_catalog (name, category_id, digitacion_price, unit_type, active, por_confirmar, notarizacion,
                             descripcion, requisitos, reglas, alias)
SELECT 'Certificación de Vehículo (Plan Piloto)',
       (SELECT id FROM service_categories WHERE name = 'Solicitud de Certificaciones' LIMIT 1),
       500, 'por vehículo', true, false, 'no_aplica',
       'Gestión de la cita y la certificación de un vehículo en el Plan Piloto.',
       'Cédula del propietario del vehículo (de ambos lados) y la matrícula del vehículo.',
       'El precio es el de la gestión; el impuesto de la certificación va aparte y lo confirma el digitador: dígalo así ("más el impuesto"). En el mismo mensaje del precio pida la cédula del propietario del vehículo (de ambos lados), la matrícula del vehículo y cuándo le gustaría la cita para llevar el vehículo; no confirme la cita usted: la agenda el equipo. Solo se reciben solicitudes con 48 horas de antelación y se agendan en horario laboral; las instituciones responden solo en días laborables y pueden tardar.',
       ARRAY['plan piloto', 'cita plan piloto', 'cita al plan piloto', 'certificacion de vehiculo', 'certificacion vehiculo plan piloto', 'revision plan piloto']
WHERE NOT EXISTS (SELECT 1 FROM service_catalog WHERE name = 'Certificación de Vehículo (Plan Piloto)');

SELECT 'Migration 20261028_certificacion_vehiculo_plan_piloto completed successfully' AS status;
