-- Seguimiento de cotizaciones (Jay, 2026-11-27): interruptor por cliente. El general sigue en
-- business_info.seguimiento_cotizaciones.activo y ahora se cambia desde el panel del bot. Idempotente.
ALTER TABLE IF EXISTS clients ADD COLUMN IF NOT EXISTS followup_off BOOLEAN NOT NULL DEFAULT false;
