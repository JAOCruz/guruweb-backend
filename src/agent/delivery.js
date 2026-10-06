// Servicio de entregas: cotizaciones y documentos aprobados salen en PDF por WhatsApp.
// Lo llaman las acciones del panel (aprobar, confirmar pago, "Enviar al cliente"); no hay
// ningún proceso en segundo plano. Cada envío es de una sola vez: la fila se marca como
// enviada (UPDATE … WHERE sent_at IS NULL RETURNING) antes de enviar y se revierte si falla.
// Nada sale en Word. Si Meta cierra la ventana de 24 h (WINDOW_CLOSED) no se reintenta.
// En consola solo van ids y códigos de error.
const fs = require('fs');
const pool = require('../db/pool');
const Invoice = require('../models/Invoice');
const Message = require('../models/Message');
const Portfolio = require('../documentos/portfolio');
const storage = require('../utils/storage');
const pdf = require('../documentos/pdf');
const { getBusinessInfo } = require('./businessInfo');
const { activeAdminIds, notifyUsers } = require('./tools/notify');
const { logActivity, rd } = require('../services/activityLog');

const DEFAULT_PAYMENT_METHODS = 'transferencia o efectivo';
const WINDOW_TEXT = 'pero WhatsApp no deja escribirle porque pasaron más de 24 h desde su último mensaje. '
  + 'Envíelo por otro medio, o espere a que el cliente escriba y pulse Enviar.';

// Dobles para pruebas: el canal de WhatsApp, el conversor Word → PDF y el generador del PDF de la cotización.
let sender = null;
let converter = null;
let invoicePdf = null;
function getSender() {
  if (!sender) sender = require('../whatsapp/outgoing'); // perezoso: arrastra Baileys
  return sender;
}
function _setSender(s) { sender = s || null; }
function _setConverter(fn) { converter = fn || null; }
function _setInvoicePdf(fn) { invoicePdf = fn || null; }

function convert(input, target) {
  return (converter || pdf.convertToPdf)(input, target);
}

// Mismo PDF que POST /invoices/:id/send-whatsapp.
async function generateQuotePdf(invoice) {
  if (invoicePdf) return invoicePdf(invoice);
  const { generateInvoicePDF } = require('../documents/generateInvoice'); // perezoso: arrastra storage/weasyprint
  const created = new Date(invoice.created_at || Date.now());
  const dateStr = `${String(created.getDate()).padStart(2, '0')}-${String(created.getMonth() + 1).padStart(2, '0')}-${created.getFullYear()}`;
  return generateInvoicePDF({
    clientName: invoice.client_name,
    clientPhone: invoice.client_phone,
    docNumber: invoice.doc_number,
    date: dateStr,
    items: typeof invoice.items === 'string' ? JSON.parse(invoice.items) : invoice.items,
    notes: invoice.notes,
    type: invoice.type,
    discountType: invoice.discount_type,
    discountValue: invoice.discount_value,
    discountAmount: invoice.discount_amount,
    discountCode: invoice.discount_code,
  });
}

function safeFileName(title) {
  return String(title || 'documento').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim() || 'documento';
}

// Un intento; otro más si el fallo no es la ventana de 24 h. Devuelve { result } o { code }.
async function sendWithRetry(target, filePath, fileName, caption) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await getSender().sendDocument(target, filePath, fileName, caption);
      return { result };
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'WINDOW_CLOSED') return { code: 'WINDOW_CLOSED' };
    }
  }
  return { code: 'SEND_FAILED', error: lastErr };
}

async function notifyAdmins(message, metadata) {
  await notifyUsers(await activeAdminIds(), {
    type: 'delivery', title: 'Envío por WhatsApp pendiente', message,
    link: metadata.invoice_id && !metadata.document_id ? '/cotizaciones' : '/documentos', metadata,
  });
}

function failureText(kind, label, clientName, code) {
  const who = clientName || 'cliente sin nombre';
  if (code === 'WINDOW_CLOSED') {
    return kind === 'quote'
      ? `La cotización ${label} de ${who} está aprobada, ${WINDOW_TEXT.replace('Envíelo', 'Envíela')}`
      : `El documento «${label}» de ${who} está aprobado, ${WINDOW_TEXT}`;
  }
  const what = kind === 'quote' ? `la cotización ${label}` : `el documento «${label}»`;
  if (code === 'PDF_FAILED') return `No se pudo generar el PDF de ${what} de ${who}. Revise el documento y pulse Enviar de nuevo.`;
  return `No se pudo enviar ${what} de ${who} por WhatsApp. Revise la conexión y pulse Enviar de nuevo.`;
}

async function recordOutbound({ phone, clientId, content, waId, target }) {
  return Message.create({
    waMessageId: waId || null, phone, clientId: clientId || null, direction: 'outbound', content,
    waJid: target && String(target).includes('@') ? target : null,
  });
}

function waId(result) {
  return result?.key?.id || result?.messages?.[0]?.id || null;
}

// ── Cotizaciones ─────────────────────────────────────────────────────────────

// Solo salen cotizaciones aprobadas (o ya enviadas/pagadas, p.ej. reenvío tras WINDOW_CLOSED).
const SENDABLE_STATUSES = new Set(['approved', 'sent', 'paid']);

// Tras un envío que salió bien, el registro nunca deshace la marca ni rompe la respuesta.
async function afterSend(kind, id, step, fn) {
  try {
    await fn();
  } catch (err) {
    console.error('[delivery]', kind, id, 'registro', step, err.code || 'ERROR');
  }
}

async function sendQuote(invoiceId, { actor } = {}) {
  const invoice = await Invoice.findById(invoiceId);
  if (!invoice) return { ok: false, code: 'NOT_FOUND' };
  if (!SENDABLE_STATUSES.has(invoice.status)) return { ok: false, code: 'NOT_APPROVED' };
  if (!invoice.client_phone) return { ok: false, code: 'NO_PHONE' };

  const claim = await pool.query(
    `UPDATE invoices SET sent_by_bot_at = NOW(), send_error = NULL WHERE id = $1 AND sent_by_bot_at IS NULL RETURNING id`,
    [invoice.id]
  );
  if (!claim.rows.length) return { ok: false, code: 'ALREADY_SENT' };

  const fail = async (code) => {
    await pool.query('UPDATE invoices SET sent_by_bot_at = NULL, send_error = $2 WHERE id = $1', [invoice.id, code]);
    console.error('[delivery] cotización', invoice.id, code);
    await notifyAdmins(failureText('quote', invoice.doc_number, invoice.client_name, code),
      { invoice_id: invoice.id, doc_number: invoice.doc_number, code });
    return { ok: false, code };
  };

  // Desde la marca hasta el envío: cualquier fallo revierte la marca; la fila nunca queda atascada.
  let pdfPath, caption, phone, target, sent, code = null;
  try {
    pdfPath = invoice.pdf_path;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      pdfPath = await generateQuotePdf(invoice).catch(() => null);
    }
    if (!pdfPath) {
      code = 'PDF_FAILED';
    } else {
      const info = await getBusinessInfo().catch(() => ({}));
      const formas = Array.isArray(info.formas_pago) && info.formas_pago.length ? info.formas_pago.join(' o ') : DEFAULT_PAYMENT_METHODS;
      caption = `Le comparto su cotización ${invoice.doc_number} por ${rd(invoice.total)}. Formas de pago: ${formas}.`
        + (info.direccion ? ` Estamos en ${info.direccion}.` : '') + ' Cualquier duda me escribe. 🦉';
      phone = invoice.client_phone;
      target = (await Message.getLastJid(phone)) || phone;
      sent = await sendWithRetry(target, pdfPath, `${invoice.doc_number}.pdf`, caption);
      code = sent.code || null;
    }
  } catch (err) {
    console.error('[delivery] cotización', invoice.id, 'inesperado', err.code || 'ERROR');
    code = 'SEND_FAILED';
  }
  if (code) return fail(code);

  await afterSend('cotización', invoice.id, 'mensaje', () =>
    recordOutbound({ phone, clientId: invoice.client_id, content: caption, waId: waId(sent.result), target }));
  await afterSend('cotización', invoice.id, 'estado', () =>
    Invoice.markSent(invoice.id, pdfPath, invoice.pdf_s3_key || null, invoice.pdf_s3_key ? 's3' : 'railway_volume'));
  await afterSend('cotización', invoice.id, 'actividad', () => logActivity(null, {
    actor, category: 'facturas', action: 'invoice.send', entityType: 'invoice', entityId: invoice.id,
    summary: `Envió la cotización ${invoice.doc_number} a ${invoice.client_name || 'cliente sin nombre'} por WhatsApp (${rd(invoice.total)})`,
    details: { doc_number: invoice.doc_number, type: invoice.type, client_name: invoice.client_name, total: invoice.total, via: 'delivery' },
  }));
  return { ok: true };
}

// ── Documentos ───────────────────────────────────────────────────────────────

async function loadDocument(documentId) {
  const { rows } = await pool.query(
    `SELECT d.id, d.title, d.client_id, d.invoice_id, d.approved_version_id, d.sent_at, c.name AS client_name, c.phone AS client_phone
     FROM portfolio_documents d JOIN clients c ON c.id = d.client_id WHERE d.id = $1`,
    [Number(documentId)]
  );
  return rows[0] || null;
}

// PDF de la versión aprobada: el ya guardado, el archivo si se subió en PDF, o la conversión del Word.
async function documentPdf(version) {
  if (version.pdf_path && fs.existsSync(version.pdf_path)) return version.pdf_path;
  if (version.mime_type === 'application/pdf' && fs.existsSync(version.file_path)) return version.file_path;
  const target = storage.getFilePath('portfolio_pdf', `${version.id}.pdf`);
  const out = await convert(version.file_path, target);
  await Portfolio.setVersionPdf(version.id, out);
  return out;
}

async function sendDocument(documentId, { actor } = {}) {
  const doc = await loadDocument(documentId);
  if (!doc) return { ok: false, code: 'NOT_FOUND' };
  if (!doc.approved_version_id) return { ok: false, code: 'NOT_APPROVED' };
  if (!doc.client_phone) return { ok: false, code: 'NO_PHONE' };

  const claim = await pool.query(
    `UPDATE portfolio_documents SET sent_at = NOW(), send_error = NULL WHERE id = $1 AND sent_at IS NULL RETURNING id`,
    [doc.id]
  );
  if (!claim.rows.length) return { ok: false, code: 'ALREADY_SENT' };

  const fail = async (code) => {
    await pool.query('UPDATE portfolio_documents SET sent_at = NULL, send_error = $2 WHERE id = $1', [doc.id, code]);
    console.error('[delivery] documento', doc.id, code);
    await notifyAdmins(failureText('document', doc.title, doc.client_name, code),
      { document_id: doc.id, invoice_id: doc.invoice_id || undefined, code });
    return { ok: false, code };
  };

  // Desde la marca hasta el envío: cualquier fallo revierte la marca; la fila nunca queda atascada.
  const caption = `Aquí tiene su documento «${doc.title}». Gracias por confiar en Gurú. 🦉`;
  const phone = doc.client_phone;
  let version, target, sent, code = null;
  try {
    const { rows: versions } = await pool.query(
      'SELECT * FROM portfolio_versions WHERE id = $1 AND document_id = $2', [doc.approved_version_id, doc.id]
    );
    version = versions[0];
    const pdfPath = version ? await documentPdf(version).catch(() => null) : null;
    if (!pdfPath) {
      code = 'PDF_FAILED';
    } else {
      target = (await Message.getLastJid(phone)) || phone;
      sent = await sendWithRetry(target, pdfPath, `${safeFileName(doc.title)}.pdf`, caption);
      code = sent.code || null;
    }
  } catch (err) {
    console.error('[delivery] documento', doc.id, 'inesperado', err.code || 'ERROR');
    code = 'SEND_FAILED';
  }
  if (code) return fail(code);

  await afterSend('documento', doc.id, 'mensaje', () =>
    recordOutbound({ phone, clientId: doc.client_id, content: caption, waId: waId(sent.result), target }));
  await afterSend('documento', doc.id, 'estado', () =>
    pool.query('UPDATE portfolio_documents SET updated_at = NOW() WHERE id = $1', [doc.id]));
  await afterSend('documento', doc.id, 'actividad', () => logActivity(null, {
    actor, category: 'documentos', action: 'documento.send', entityType: 'documento', entityId: doc.id,
    summary: `Envió «${doc.title}» a ${doc.client_name || 'cliente sin nombre'} por WhatsApp`,
    details: { client_name: doc.client_name, version_id: version.id, invoice_id: doc.invoice_id, via: 'delivery' },
  }));
  return { ok: true };
}

// Al confirmar el pago: salen los documentos de esa cotización aprobados con "Enviar cuando pague".
// Devuelve cuántos salieron; un fallo en uno no detiene a los demás.
async function deliverPaidDocuments(invoiceId, { actor } = {}) {
  const { rows } = await pool.query(
    `SELECT id FROM portfolio_documents
     WHERE invoice_id = $1 AND approved_version_id IS NOT NULL AND send_mode = 'al_pagar' AND sent_at IS NULL
     ORDER BY id`,
    [Number(invoiceId)]
  );
  let n = 0;
  for (const row of rows) {
    const r = await sendDocument(row.id, { actor });
    if (r.ok) n++;
  }
  return n;
}

module.exports = { sendQuote, sendDocument, deliverPaidDocuments, _setSender, _setConverter, _setInvoicePdf };
