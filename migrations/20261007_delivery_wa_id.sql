-- Bot fase 2 (revisión final): id del mensaje de WhatsApp de cada entrega. Idempotente.
-- Meta acepta un envío fuera de la ventana de 24 h y después avisa por webhook (status "failed" 131047/131026);
-- con este id se sabe qué cotización o documento revertir (sent_at / sent_by_bot_at) y marcar WINDOW_CLOSED.
ALTER TABLE portfolio_documents ADD COLUMN IF NOT EXISTS delivery_wa_id TEXT;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS delivery_wa_id TEXT;

CREATE INDEX IF NOT EXISTS portfolio_documents_delivery_wa_idx ON portfolio_documents (delivery_wa_id) WHERE delivery_wa_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_delivery_wa_idx ON invoices (delivery_wa_id) WHERE delivery_wa_id IS NOT NULL;
