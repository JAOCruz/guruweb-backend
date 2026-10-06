const pool = require('../../db/pool');
const { ensureClient } = require('./client');
const { activeAdminIds, notifyUsers } = require('./notify');

// avisar_pago: el cliente mandó lo que parece un comprobante (transferencia, depósito). El bot solo avisa a los
// admins activos; nunca confirma el pago ni cambia el estado de ninguna cotización (eso lo hace una persona en
// Cotizaciones con confirm-payment). El aviso lleva solo lo leído del comprobante: monto, banco y referencia.

const looksLikePhone = (n) => !n || /^[\d\s+()-]+$/.test(String(n).trim());
const text = (v) => (v == null ? '' : String(v).trim());

// La cotización abierta más reciente del cliente: por aprobar, aprobada o enviada. Pagadas o rechazadas no cuentan.
async function openInvoiceId(clientId) {
  if (!clientId) return null;
  const { rows } = await pool.query(
    `SELECT id FROM invoices WHERE client_id = $1 AND status IN ('approved', 'sent', 'pending_approval')
     ORDER BY created_at DESC, id DESC LIMIT 1`, [clientId]);
  return rows[0] ? rows[0].id : null;
}

async function avisar_pago(args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  const client = await ensureClient(ctx);
  const phone = String(ctx.phone || '');
  const who = client && !looksLikePhone(client.name) ? client.name : phone;
  const mediaId = Number.isInteger(Number(a.media_id)) && Number(a.media_id) > 0 ? Number(a.media_id) : null;
  const invoiceId = await openInvoiceId(client?.id);

  const leido = [['Monto', text(a.monto)], ['Banco', text(a.banco)], ['Referencia', text(a.referencia)]]
    .filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
  const message = leido.length
    ? `Comprobante recibido por WhatsApp, por verificar. ${leido.join(' · ')}.`
    : 'Comprobante recibido por WhatsApp, por verificar.';

  await notifyUsers(await activeAdminIds(), {
    type: 'payment',
    title: `💵 Comprobante de pago: ${who}`.slice(0, 255),
    message,
    link: `/bot-messages?phone=${encodeURIComponent(phone)}`,
    metadata: { phone, media_id: mediaId, invoice_id: invoiceId },
  });
  return { avisado: true };
}

module.exports = { avisar_pago };
