-- ============================================================
-- invoices_status_check sin 'pending_approval'. Las dos migraciones del 2025-08-15 reescriben esta regla: la de
-- pending_approval la agrega y la de reject, que corre después (orden alfabético), la vuelve a escribir sin él.
-- Con eso preparar_cotizacion del bot fallaba (23514), quedaban borradores sueltos y el chat pasaba a una persona;
-- "Pedir aprobación" del panel también fallaba. Se deja la regla con todos los estados. Idempotente.
-- ============================================================
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_status_check;
ALTER TABLE invoices ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'pending_approval', 'approved', 'sent', 'paid', 'cancelled', 'rejected'));

SELECT 'Migration 20261031_estado_por_aprobar completed successfully' AS status;
