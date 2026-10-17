-- ============================================================
-- Reglas de atención (respuestas de Leandro, punto 3 de pendientes)
-- Date: 2026-10-17
--   - temas_humano separado por destino (admin / digitador)
--   - mensaje de espera "Un Gurú…" + versión en inglés
--   - vigencia de la cotización (7 días) e instituciones con las que trabajamos
-- Idempotente: se puede correr varias veces.
-- ============================================================

INSERT INTO business_info (clave, valor, updated_at) VALUES
  ('temas_humano', $j${
    "admin": ["reclamos de precio", "temas administrativos o que haya que escalar a un superior", "pagos, abonos y pagos no realizados", "propuestas", "proveedores", "clientes importantes", "descuentos (si el cliente insiste)", "devoluciones", "clientes groseros o spam"],
    "digitador": ["errores en contratos", "malentendidos con la información", "tickets y reclamos del servicio", "pagos de un trabajo en curso", "estado de una solicitud o de una certificación", "seguimiento de trámites ligados a los documentos", "procesos que siguen para hacer otro documento"]
  }$j$::jsonb, NOW()),
  ('mensaje_espera', to_jsonb($m$Un Gurú de nuestro equipo se comunicará con usted a la brevedad. ⏰ Horario de atención: Lunes a Viernes, 9:00 a 18:00 hrs. Si su asunto es urgente fuera de horario, por favor indíquelo escribiendo 'urgente'.$m$::text), NOW()),
  ('mensaje_espera_en', to_jsonb($m$A Gurú from our team will contact you shortly. ⏰ Business hours: Monday to Friday, 9:00 to 18:00 (Dominican Republic time). If your matter is urgent outside business hours, please let us know by writing 'urgent'.$m$::text), NOW()),
  ('vigencia_cotizacion_dias', '7'::jsonb, NOW()),
  ('instituciones', '["Relaciones Exteriores (MIREX)", "Plan Piloto", "Ministerio Público o Procuraduría General de la República", "Poder Judicial", "Jurisdicción Inmobiliaria o Tribunal de Tierras", "ONAPI", "Dirección General de Migración"]'::jsonb, NOW())
ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, updated_at = NOW();

SELECT 'Migration 20261017_reglas_atencion completed successfully' AS status;
