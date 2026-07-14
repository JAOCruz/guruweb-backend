/**
 * Billing flow — Invoice generation from WhatsApp
 * Triggered after consultation (intake complete or case discussed).
 *
 * Flow:
 *   ask_services   → bot asks for services/items to bill
 *   confirm_details → bot shows items + totals for confirmation
 *   generating     → creates invoice in DB, generates PDF, sends via WhatsApp
 */
const path = require('path');
const Invoice = require('../../models/Invoice');
const { transitionTo, updateData } = require('../stateManager');
const { MSG, LIST } = require('../messages');
const { withList } = require('../../whatsapp/interactive');
const { sendDocumentToChat } = require('../../whatsapp/sender');
const { generateInvoicePDF, generateInvoiceFromTemplate, generateDocNumber } = require('../../documents/generateInvoice');
const { normalize } = require('../nlp');
const { isSimulatorPhone, getSource } = require('../../utils/simulator');

const FREE_TEXT = new Set(['billing:ask_services', 'billing:confirm_details', 'billing:quote_confirm']);

// ── Main handler ──────────────────────────────────────────────────────────────

async function handle(session, text, msg) {
  const step = session.step;

  // Escape intent — return to main menu
  if (['billing:ask_services', 'billing:confirm_details', 'billing:quote_confirm'].includes(step)) {
    const { isEscapeIntent } = require('../nlp');
    if (isEscapeIntent(text)) {
      await transitionTo(session, 'main_menu', 'show');
      return withList('🦉 Proceso de facturación cancelado. ¿En qué más puedo ayudarle?\n\n' + MSG.MAIN_MENU, LIST.MAIN_MENU);
    }
  }

  switch (step) {
    case 'quote_confirm':
      return await handleQuoteConfirm(session, text);

    case 'ask_services':
      return await handleAskServices(session, text);

    case 'confirm_details':
      return await handleConfirmDetails(session, text);

    case 'generating':
      // Guard: prevent re-processing on text reply during generation
      return '⏳ Ya estamos generando su documento. Recibirá el PDF en breves momentos.';

    default:
      await transitionTo(session, 'main_menu', 'show');
      return withList(MSG.MAIN_MENU, LIST.MAIN_MENU);
  }
}

// ── Step: ask_services ────────────────────────────────────────────────────────

async function handleAskServices(session, text) {
  // First message — parse items from what the user typed, or ask for them
  const raw = text.trim();

  if (!raw || raw.length < 5) {
    return `📋 Para generar su factura necesito los servicios a facturar.\n\n` +
      `Ingrese cada línea así:\n` +
      `*Descripción, cantidad, precio*\n\n` +
      `Ejemplo:\n` +
      `*Consulta legal, 1, 5000*\n` +
      `*Elaboración de contrato, 2, 8500*\n\n` +
      `_Escriba *cancelar* para salir._`;
  }

  // Parse items: "desc, cantidad, precio" per line
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  const errors = [];

  for (const line of lines) {
    // Match: "desc, cantidad, precio" — handle both comma and pipe separators
    const parts = line.split(/[,\|]/).map(p => p.trim());
    if (parts.length < 3) {
      errors.push(`"${line}" — formato inválido (use: descripción, cantidad, precio)`);
      continue;
    }
    const desc = parts[0];
    const cantidad = parseInt(parts[parts.length - 2], 10);
    const precio = parseFloat(parts[parts.length - 1].replace(/[RD$ ,]/g, '').replace(',', '.'));
    if (isNaN(cantidad) || isNaN(precio)) {
      errors.push(`"${line}" — cantidad o precio no válido`);
      continue;
    }
    items.push({ desc, cantidad, itbis: true }); // ITBIS default true for legal services
  }

  if (items.length === 0) {
    return `⚠️ No pude entender los servicios ingresados.\n\n` +
      `Formato por línea:\n` +
      `*Descripción, cantidad, precio*\n\n` +
      `Ejemplo:\n` +
      `*Consulta legal, 1, 5000*\n` +
      `*Elaboración de contrato, 2, 8500*\n\n` +
      `_Escriba *cancelar* para salir._`;
  }

  if (errors.length > 0 && items.length === 0) {
    return `⚠️ Errores encontrados:\n${errors.map(e => `• ${e}`).join('\n')}\n\n` +
      `Por favor reingrese los servicios correctamente.`;
  }

  const subtotal = items.reduce((s, i) => s + i.cantidad * i.precio, 0);
  const itbis = subtotal * 0.18;
  const total = subtotal + itbis;

  const data = {
    items,
    subtotal,
    itbis,
    total,
    clientName: session.data?.clientName || session.data?.name || 'Cliente',
    clientPhone: session.phone,
    notes: errors.length > 0 ? `Nota: ${errors.join('; ')}` : null,
  };

  await updateData(session, data);
  await transitionTo(session, 'billing', 'confirm_details', data);

  return buildConfirmationMessage(data, errors);
}

// ── Step: confirm_details ─────────────────────────────────────────────────────

async function handleConfirmDetails(session, text) {
  const choice = normalize(text);
  const data = session.data;

  if (choice === '1' || choice === 'si' || choice === 'sí' || choice === 'confirmar' || choice === 'correcto') {
    await transitionTo(session, 'billing', 'generating');
    return await generateAndSendInvoice(session);
  }

  if (choice === '2' || choice === 'no' || choice === 'corregir' || choice === 'modificar') {
    await transitionTo(session, 'billing', 'ask_services', { items: null });
    return `🔄 De acuerdo. Ingrese nuevamente los servicios a facturar:\n\n` +
      `Formato:\n*Descripción, cantidad, precio*\n\n` +
      `Ejemplo:\n*Consulta legal, 1, 5000*\n*Elaboración de contrato, 2, 8500*\n\n` +
      `_Escriba *cancelar* para salir._`;
  }

  return `Seleccione:\n1️⃣ *Sí, generar la factura*\n2️⃣ *No, corregir los datos*\n\n` +
    `_Escriba *cancelar* para salir sin generar._`;
}

// ── Generate + send invoice ───────────────────────────────────────────────────

async function generateAndSendInvoice(session) {
  const data = session.data;
  const phone = session.phone;
  const isSimulator = isSimulatorPhone(phone);
  const source = getSource(phone);

  try {
    // 1. Create invoice in DB (as draft)
    const docNumber = generateDocNumber('FAC');
    const invoice = await Invoice.create({
      docNumber,
      type: 'FACTURA',
      clientId: data.clientId || null,
      clientName: data.clientName || 'Cliente',
      clientPhone: data.clientPhone || phone,
      items: data.items,
      notes: data.notes || null,
      subtotal: data.subtotal,
      itbis: data.itbis,
      total: data.total,
      createdBy: data.userId || 1,
      source,
    });

    console.log(`[Billing] Invoice created: ${docNumber} for ${data.clientName} (source=${source})`);

    // 2. Generate PDF
    const today = new Date();
    const dateStr = `${String(today.getDate()).padStart(2,'0')}-${String(today.getMonth()+1).padStart(2,'0')}-${today.getFullYear()}`;

    let pdfPath;
    try {
      pdfPath = await generateInvoiceFromTemplate({
        clientName: data.clientName || 'Cliente',
        clientPhone: data.clientPhone || phone,
        docNumber,
        date: dateStr,
        items: data.items,
        notes: data.notes || null,
        type: 'FACTURA',
      });
    } catch (pdfErr) {
      console.error('[Billing] PDF generation failed:', pdfErr.message);
      pdfPath = null;
    }

    // 3. Mark as sent (draft → sent, stores pdf_path)
    await Invoice.markSent(invoice.id, pdfPath);

    // 4. Send PDF via WhatsApp (skip for simulator)
    if (pdfPath && !isSimulator) {
      const jid = `${phone}@s.whatsapp.net`;
      try {
        await sendDocumentToChat(jid, pdfPath, `${docNumber}.pdf`);
      } catch (sendErr) {
        console.error('[Billing] WhatsApp send failed:', sendErr.message);
      }
    }

    await transitionTo(session, 'main_menu', 'show', {});
    const sendLabel = isSimulator ? 'generada en modo simulador' : 'generada y enviada';
    return `✅ *Factura ${sendLabel}*\n\n` +
      `📄 *${docNumber}*\n` +
      `👤 *${data.clientName}*\n` +
      `📌 *RD$ ${data.total.toLocaleString('es-DO', { minimumFractionDigits: 2 })}*\n\n` +
      (isSimulator
        ? `La factura quedó guardada en el sistema para revisión.\n\n`
        : `Su factura ha sido enviada a este chat.\nNuestro equipo se pondrá en contacto para procesar el pago.\n\n`) +
      `¿En qué más puedo ayudarle?\n\n` + MSG.MAIN_MENU;

  } catch (err) {
    console.error('[Billing] Invoice generation error:', err);
    await transitionTo(session, 'main_menu', 'show', {});
    return `❌ Ocurrió un error al generar la factura.\n\n` +
      `Por favor contacte a nuestro equipo o escriba *"menu"* para volver al inicio.\n\n` + MSG.MAIN_MENU;
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(n) {
  return `RD$ ${n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function buildConfirmationMessage(data, errors = []) {
  const lines = [
    `📋 *Resumen de Factura*\n`,
    `─────────────────────`,
  ];

  data.items.forEach((item, i) => {
    lines.push(`${i + 1}. *${item.desc}*`);
    lines.push(`   ${item.cantidad} × ${fmt(item.precio)} = *${fmt(item.cantidad * item.precio)}*`);
  });

  lines.push(`─────────────────────`);
  lines.push(`Subtotal: *${fmt(data.subtotal)}*`);
  lines.push(`ITBIS (18%): *${fmt(data.itbis)}*`);
  lines.push(`*TOTAL: ${fmt(data.total)}*`);

  if (errors.length > 0) {
    lines.push(`\n⚠️ *Nota:* ${errors.join('; ')}`);
  }

  lines.push(`\nSeleccione:`);
  lines.push(`1️⃣ *Sí, generar la factura*`);
  lines.push(`2️⃣ *No, corregir los datos*`);

  return lines.join('\n');
}

// ── Step: quote_confirm ───────────────────────────────────────────────────────
// Handle auto-generated quote confirmation and invoice generation

async function handleQuoteConfirm(session, text) {
  const normalized = (text || '').toLowerCase().trim();
  const isConfirm = /^(sí|si|yes|y|1|confirmar|generar|ok)/.test(normalized);
  const isModify = /^(no|2|modificar|cambiar|corregir)/.test(normalized);

  if (!isConfirm && !isModify) {
    return `❓ No entendí. ¿Desea proceder con la factura?\n\n` +
      `*SÍ* — Generar factura\n` +
      `*NO* — Cancelar`;
  }

  if (!isConfirm) {
    // User wants to modify or cancel
    await transitionTo(session, 'main_menu', 'show');
    return withList('🦉 Cotización cancelada. ¿En qué más puedo ayudarle?\n\n' + MSG.MAIN_MENU, LIST.MAIN_MENU);
  }

  // User confirmed — generate invoice from quote
  const quoteData = session.data.quote || {};
  const items = (session.data.quoteItems || []).map(item => ({
    desc: item.name,
    cantidad: item.quantity,
    precio: item.unitPrice,
    itbis: false, // No ITBIS for retail items
  }));

  if (items.length === 0) {
    return `⚠️ No hay items en la cotización. Regresando al menú...`;
  }

  await transitionTo(session, 'billing', 'generating', {
    quote: quoteData,
    quoteItems: items,
    quoteTotal: session.data.quoteTotal,
    source: 'auto_quote',
  });

  // Generate invoice
  try {
    const docNum = generateDocNumber('COT');
    const today = new Date();
    const dateStr = `${String(today.getDate()).padStart(2,'0')}-${String(today.getMonth()+1).padStart(2,'0')}-${today.getFullYear()}`;

    console.log(`[Billing] Quote confirm - items: ${JSON.stringify(items)}`);

    // Save quotation to database
    const quotation = await Invoice.create({
      docNumber: docNum,
      type: 'COTIZACIÓN',
      clientId: null,
      clientName: session.data?.clientName || 'Cliente',
      clientPhone: session.phone,
      items,
      notes: '📱 Cotización generada vía WhatsApp. Pago del 100% al recibir el documento finalizado. Retiro en tienda física en horario disponible: 9:00 a.m. a 5:30 p.m. (hora Santo Domingo, RD).',
      subtotal: items.reduce((s, i) => s + (i.cantidad * i.precio), 0),
      itbis: 0,
      total: session.data.quoteTotal,
      createdBy: 1, // System-generated quotations
    });

    console.log(`[Billing] Quotation saved to DB: ${quotation.id}`);

    const pdfPath = await generateInvoiceFromTemplate({
      clientName: session.data?.clientName || 'Cliente',
      clientPhone: session.phone,
      docNumber: docNum,
      date: dateStr,
      items,
      notes: '📱 Cotización generada vía WhatsApp. Pago del 100% al recibir el documento finalizado. Retiro en tienda física en horario disponible: 9:00 a.m. a 5:30 p.m. (hora Santo Domingo, RD).',
      type: 'COTIZACIÓN',
    });

    // Update quotation with PDF path
    await Invoice.update(quotation.id, { pdf_path: pdfPath });

    console.log(`[Billing] PDF generated at: ${pdfPath}`);

    const pdfFilename = path.basename(pdfPath);
    const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';
    const pdfUrl = `${baseUrl}/api/invoices/pdf/${pdfFilename}`;

    console.log(`[Billing] Invoice generated from auto-quote: ${docNum}, total RD$ ${session.data.quoteTotal}`);
    console.log(`[Billing] PDF URL: ${pdfUrl}`);

    // Generate PDF preview image
    let previewPath = null;
    try {
      const { execSync } = require('child_process');
      const os = require('os');
      const fs = require('fs');

      previewPath = path.join(os.tmpdir(), `${docNum}-preview.png`);
      console.log(`[Billing] Generating PDF preview...`);

      const { spawnSync } = require('child_process');
      const script = `
from pdf2image import convert_from_path
import sys
images = convert_from_path(sys.argv[1], first_page=1, last_page=1, dpi=150)
if images:
  images[0].save(sys.argv[2], 'PNG')
`;
      const result = spawnSync('python3', ['-c', script, pdfPath, previewPath], {
        timeout: 10000,
        encoding: 'utf-8',
      });
      if (result.status !== 0) {
        throw new Error(result.stderr || `pdf2image exited with code ${result.status}`);
      }

      if (!fs.existsSync(previewPath)) {
        previewPath = null;
      } else {
        console.log(`[Billing] PDF preview created successfully`);
      }
    } catch (previewErr) {
      console.warn(`[Billing] Could not generate preview:`, previewErr.message);
      previewPath = null;
    }

    // Return to menu with PDF link (natural conversation flow, no numbered menu)
    await transitionTo(session, 'main_menu', 'show');

    const responseMsg = `✅ *Factura #${docNum} generada*\n\n` +
      `💰 *Total: RD$ ${session.data.quoteTotal.toLocaleString('es-DO')}*\n\n` +
      `📥 Descargar PDF:\n${pdfUrl}\n\n` +
      `Nuestro equipo se pondrá en contacto para procesar el pago.\n\n` +
      `¿En qué más puedo ayudarle?`;

    // Send preview image if available
    if (previewPath) {
      try {
        const { sendImageToChat } = require('../../whatsapp/sender');
        const jid = `${session.phone}@s.whatsapp.net`;
        await sendImageToChat(jid, previewPath, responseMsg);
        console.log(`[Billing] Preview image sent`);
      } catch (imgErr) {
        console.warn(`[Billing] Could not send preview:`, imgErr.message);
      }
    }

    return responseMsg;
  } catch (err) {
    console.error('[Billing] Invoice generation error:', err.message, err.stack);
    await transitionTo(session, 'main_menu', 'show');
    return `⚠️ Error al generar la factura. Por favor intente de nuevo más tarde.\n\n¿En qué más puedo ayudarle?`;
  }
}

module.exports = { handle, FREE_TEXT };
