const express = require('express');
const fs = require('fs');
const path = require('path');
const pool = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');
const { isS3Configured, uploadLocalFile, getS3Key, getSignedDownloadUrl } = require('../utils/s3');
const storage = require('../utils/storage');

function isEmployee(role) {
  return role !== 'admin';
}

// Employees only see the document itself (detail, PDF) once an admin approved it;
// before that they just see its status in the list.
const EMPLOYEE_VIEWABLE = ['approved', 'sent', 'paid'];
function blockUnapproved(req, res, invoice) {
  if (isEmployee(req.user.role) && !EMPLOYEE_VIEWABLE.includes(invoice.status)) {
    res.status(403).json({ error: 'El admin debe aprobar este documento antes de que puedas verlo', code: 'NOT_APPROVED' });
    return true;
  }
  return false;
}
const Invoice = require('../models/Invoice');

// ── Partidas por confirmar ──
// Una línea { precio: null, por_confirmar: true, rango, precio_sugerido, nota } espera que una persona ponga el precio.
const parseItems = (items) => (typeof items === 'string' ? JSON.parse(items || '[]') : items || []);
const hasPendingPrices = (inv) => parseItems(inv.items).some((i) => i && i.por_confirmar === true);
const lineTotal = (i) => (i && i.precio !== null && i.precio !== undefined ? Number(i.cantidad) * Number(i.precio) : 0) || 0;
function pricesPending(res) {
  return res.status(400).json({ error: 'Faltan precios por confirmar en la cotización', code: 'PRICES_PENDING' });
}
// Un precio positivo confirma la línea; si no, sigue por confirmar (sin precio).
function settleLine(line, precio) {
  const out = { ...line };
  const n = Number(precio);
  if (precio !== null && precio !== undefined && precio !== '' && Number.isFinite(n) && n > 0) {
    out.precio = n;
    delete out.por_confirmar;
  } else if (out.por_confirmar) {
    out.precio = null;
  }
  return out;
}
// El digitador asignado al cliente puede ver una cotización del bot y ponerle precios mientras no está aprobada.
async function isPricingAssignee(req, invoice) {
  if (!isEmployee(req.user.role) || invoice.source !== 'bot' || !invoice.client_id) return false;
  if (!['draft', 'pending_approval'].includes(invoice.status)) return false;
  const { rows } = await pool.query('SELECT 1 FROM clients WHERE id = $1 AND assigned_to = $2', [invoice.client_id, req.user.id]);
  return rows.length > 0;
}
const { generateInvoicePDF, generateDocNumber } = require('../documents/generateInvoice');

const Case = require('../models/Case');
const Client = require('../models/Client');
const delivery = require('../agent/delivery');
const { logActivity, rd, safeLog } = require('../services/activityLog');

const docLabel = (inv) => `${inv.type === 'FACTURA' ? 'la factura' : 'la cotización'} ${inv.doc_number}`;
function logInvoice(req, action, inv, summary, details = {}) {
  if (!inv) return Promise.resolve(); // e.g. a double click: the other request already changed it
  return logActivity(req, {
    category: 'facturas', action, entityType: 'invoice', entityId: inv.id, summary,
    details: { doc_number: inv.doc_number, type: inv.type, client_name: inv.client_name, total: inv.total, ...details },
  });
}

const { activeAdminIds, notifyUsers } = require('../agent/tools/notify');

const docKind = (inv) => (inv.type === 'FACTURA' ? 'factura' : 'cotización');
// Campana: un digitador pidió aprobación -> cada admin activo.
async function notifyApprovalRequested(req, inv) {
  if (!inv) return;
  const u = await pool.query('SELECT name, username FROM users WHERE id = $1', [req.user.id]);
  const who = u.rows[0]?.name || u.rows[0]?.username || 'Un empleado';
  await notifyUsers(await activeAdminIds(), {
    type: 'approval',
    title: `📝 ${docKind(inv) === 'factura' ? 'Factura' : 'Cotización'} por aprobar`,
    message: `${who} pidió aprobar la ${docKind(inv)} ${inv.doc_number} de ${inv.client_name || 'cliente sin nombre'} por ${rd(inv.total)}.`,
    link: `/cotizaciones?invoice=${inv.id}`,
    metadata: { invoice_id: inv.id },
  });
}
// Campana: el admin decidió -> el empleado que la creó (ni el bot ni otro admin).
async function notifyDecision(inv, approved, reason) {
  if (!inv || !inv.created_by) return;
  const { rows } = await pool.query('SELECT role FROM users WHERE id = $1', [inv.created_by]);
  if (!rows[0] || !isEmployee(rows[0].role)) return;
  const kind = docKind(inv);
  const done = approved ? 'aprobada' : 'rechazada';
  await notifyUsers([inv.created_by], {
    type: 'approval',
    title: `${approved ? '✅' : '❌'} ${kind === 'factura' ? 'Factura' : 'Cotización'} ${done}`,
    message: `La ${kind} ${inv.doc_number} de ${inv.client_name || 'cliente sin nombre'} fue ${done}${!approved && reason ? `: ${reason}` : '.'}`,
    link: `/cotizaciones?invoice=${inv.id}`,
    metadata: { invoice_id: inv.id },
  });
}

const router = express.Router();

// ── helper: calculate discount (admin-only feature) ──
function calculateDiscount({ subtotal, discountType, discountValue }) {
  if (!discountType) return { discountAmount: 0, discountType: null, discountValue: 0 };
  const value = Number(discountValue) || 0;
  let amount = 0;
  if (discountType === 'percentage') {
    amount = subtotal * (value / 100);
  } else if (discountType === 'fixed' || discountType === 'coupon') {
    amount = value;
  }
  // Discount cannot make the net total negative
  if (amount > subtotal) amount = subtotal;
  return { discountAmount: Math.round(amount * 100) / 100, discountType, discountValue: value };
}

// ── get all quotations (auth required) ──
router.get('/quotations', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*,
             cb.name AS created_by_name
      FROM invoices i
      LEFT JOIN users cb ON cb.id = i.created_by
      WHERE i.type = 'COTIZACIÓN'
        AND ($1::int IS NULL OR i.created_by = $1)
      ORDER BY i.created_at DESC
      LIMIT 50
    `, [isEmployee(req.user.role) ? req.user.id : null]);
    res.json({ quotations: rows });
  } catch (err) {
    console.error('Get quotations error:', err);
    res.status(500).json({ error: 'Failed to get quotations' });
  }
});

// ── POST /api/invoices/admin/regenerate-pdfs ── admin only
// One-off maintenance: regenerate every invoice PDF with the current layout.
// generateInvoicePDF writes to a deterministic path (<docNumber>.pdf), so the
// stored pdf_path stays valid after regeneration.
router.post('/admin/regenerate-pdfs', authenticate, requireRole('admin'), async (req, res) => {
  try {
    const invoices = await Invoice.findAll();
    const withPdf = invoices.filter(i => i.pdf_path);
    const results = { total: withPdf.length, ok: 0, failed: [] };

    for (const invoice of withPdf) {
      try {
        const created = new Date(invoice.created_at || Date.now());
        const dateStr = `${String(created.getDate()).padStart(2,'0')}-${String(created.getMonth()+1).padStart(2,'0')}-${created.getFullYear()}`;
        await generateInvoicePDF({
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
        results.ok++;
      } catch (err) {
        console.error(`[Invoice] Regenerate PDF failed for ${invoice.doc_number}:`, err.message);
        results.failed.push({ id: invoice.id, doc: invoice.doc_number, error: err.message });
      }
    }

    console.log(`[Invoice] PDF regeneration complete: ${results.ok}/${results.total} ok`);
    res.json(results);
  } catch (err) {
    console.error('Regenerate PDFs error:', err);
    res.status(500).json({ error: 'Failed to regenerate PDFs' });
  }
});

// ── serve invoice PDF by filename (auth required) ──
router.get('/pdf/:filename', authenticate, async (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // Prevent directory traversal

    // Employees only get PDFs of quotes they could list: their own or their assigned clients'.
    // Files not linked to any quote are admin-only.
    if (isEmployee(req.user.role)) {
      const { rows } = await pool.query(
        `SELECT status FROM invoices
         WHERE regexp_replace(pdf_path, '^.*/', '') = $1
           AND (created_by = $2 OR client_id IN (SELECT id FROM clients WHERE assigned_to = $2))
         LIMIT 1`,
        [filename, req.user.id]
      );
      if (!rows.length) return res.status(403).json({ error: 'Access denied' });
      if (blockUnapproved(req, res, rows[0])) return;
    }

    // Primary: Railway volume (storage.getDir('invoices'))
    const volumePath = storage.getFilePath('invoices', filename);
    if (fs.existsSync(volumePath)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      return res.sendFile(volumePath);
    }

    // Fallback: legacy public/invoices
    const publicPath = path.join(__dirname, '../../public/invoices', filename);
    const resolvedPath = path.resolve(publicPath);
    const invoicesDir = path.resolve(path.join(__dirname, '../../public/invoices'));
    if (!resolvedPath.startsWith(invoicesDir)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (fs.existsSync(resolvedPath)) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
      return res.sendFile(resolvedPath);
    }

    return res.status(404).json({ error: 'PDF not found' });
  } catch (err) {
    console.error('Serve public PDF error:', err);
    res.status(500).json({ error: 'Failed to serve PDF' });
  }
});

router.use(authenticate);

// ── GET /api/invoices/pending-approval-count ── admin only
router.get('/pending-approval-count', requireRole('admin'), async (req, res) => {
  try {
    const count = await Invoice.countPendingApproval();
    res.json({ count });
  } catch (err) {
    console.error('Pending approval count error:', err);
    res.status(500).json({ error: 'Failed to get pending approval count' });
  }
});

// ── GET /api/invoices ── list (admin: all | digitador/auxiliar: assigned clients or own)
// Query params: type, status, q (search doc_number/client_name/client_phone), created_by, from, to
router.get('/', async (req, res) => {
  try {
    const { type, status, q, created_by, from, to } = req.query;
    const isAdmin = !isEmployee(req.user.role);
    let invoices = isAdmin ? await Invoice.findAll() : await Invoice.findByAssignedTo(req.user.id);

    if (type) invoices = invoices.filter((i) => i.type === type);
    if (status) invoices = invoices.filter((i) => i.status === status);
    if (created_by && isAdmin) {
      invoices = invoices.filter((i) => String(i.created_by) === String(created_by));
    }
    if (from || to) {
      const fromDate = from ? new Date(from) : null;
      const toDate = to ? new Date(to) : null;
      invoices = invoices.filter((i) => {
        const created = new Date(i.created_at);
        if (fromDate && created < fromDate) return false;
        if (toDate) {
          const end = new Date(toDate);
          end.setHours(23, 59, 59, 999);
          if (created > end) return false;
        }
        return true;
      });
    }
    if (q && q.trim()) {
      const term = q.trim().toLowerCase();
      invoices = invoices.filter((i) =>
        (i.doc_number && i.doc_number.toLowerCase().includes(term)) ||
        (i.client_name && i.client_name.toLowerCase().includes(term)) ||
        (i.client_phone && i.client_phone.toLowerCase().includes(term))
      );
    }

    res.json({ invoices });
  } catch (err) {
    console.error('List invoices error:', err);
    res.status(500).json({ error: 'Failed to list invoices' });
  }
});

// ── GET /api/invoices/:id ──
router.get('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    // Employee can only see own invoices (or, to set prices, the bot quotes of their assigned clients)
    if (await isPricingAssignee(req, invoice)) return res.json({ invoice });
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (blockUnapproved(req, res, invoice)) return;
    res.json({ invoice });
  } catch (err) {
    console.error('Get invoice error:', err);
    res.status(500).json({ error: 'Failed to get invoice' });
  }
});

// ── POST /api/invoices ── create (any authenticated user)
router.post('/', async (req, res) => {
  try {
    const { type, clientId, clientName, clientPhone, items, notes } = req.body;
    if (!clientName || !items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'clientName and items[] are required' });
    }

    // Employees can only create invoices for clients assigned to them
    if (isEmployee(req.user.role) && clientId) {
      const client = await Client.findById(clientId);
      if (!client) return res.status(404).json({ error: 'Client not found' });
      if (client.assigned_to !== req.user.id) {
        return res.status(403).json({ error: 'Client is not assigned to you' });
      }
    }

    const defaultNotes = 'Pago del 100% al recibir el documento finalizado.\nRetiro en tienda física en horario disponible: 9:00 a.m. a 5:30 p.m. (hora Santo Domingo, RD).';
    const finalNotes = notes || defaultNotes;

    // Calculate totals
    const subtotal = items.reduce((s, i) => s + (Number(i.cantidad) * Number(i.precio)), 0);
    const itbis    = items.some(i => i.itbis)
      ? items.reduce((s, i) => s + (i.itbis ? Number(i.cantidad) * Number(i.precio) * 0.18 : 0), 0)
      : 0;

    // Discounts are admin-only
    let discount = { discountAmount: 0, discountType: null, discountValue: 0 };
    if (!isEmployee(req.user.role)) {
      const { discountType, discountValue, discountCode, discountReason } = req.body;
      discount = calculateDiscount({ subtotal, discountType, discountValue });
      if (discount.discountType) {
        discount.discountCode = discountCode || null;
        discount.discountReason = discountReason || null;
      }
    }

    const total = Math.max(0, subtotal + itbis - discount.discountAmount);

    const docNumber = generateDocNumber(type === 'FACTURA' ? 'FAC' : 'COT');

    const invoice = await Invoice.create({
      docNumber, type: type || 'COTIZACIÓN',
      clientId: clientId || null, clientName, clientPhone,
      items, notes: finalNotes, subtotal, itbis, total,
      createdBy: req.user.id,
      discountType: discount.discountType,
      discountValue: discount.discountValue,
      discountCode: discount.discountCode,
      discountAmount: discount.discountAmount,
      discountReason: discount.discountReason,
    });

    await safeLog(() => logInvoice(req, 'invoice.create', invoice, `Creó ${docLabel(invoice)} para ${invoice.client_name || 'cliente sin nombre'} por ${rd(invoice.total)}`));
    res.status(201).json({ invoice });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Doc number already exists' });
    console.error('Create invoice error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// ── PUT /api/invoices/:id ── edit (admin: any status/owner | employee: own draft only)
router.put('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      if (!(await isPricingAssignee(req, invoice))) return res.status(403).json({ error: 'Access denied' });
      // Asignado: solo los precios de las líneas que ya existen; lo demás queda como está
      const incoming = Array.isArray(req.body.items) ? req.body.items : [];
      const items = parseItems(invoice.items).map((line, idx) => {
        const inc = incoming[idx];
        return inc && typeof inc === 'object' && 'precio' in inc ? settleLine(line, inc.precio) : line;
      });
      const subtotal = items.reduce((a, i) => a + lineTotal(i), 0);
      const itbis = items.reduce((a, i) => a + (i.itbis ? lineTotal(i) * 0.18 : 0), 0);
      // El descuento que ya tenía se recalcula con el subtotal nuevo (un porcentaje cambia con los precios)
      const discount = calculateDiscount({ subtotal, discountType: invoice.discount_type, discountValue: Number(invoice.discount_value) || 0 });
      const updated = await Invoice.update(invoice.id, {
        items: JSON.stringify(items), subtotal, itbis,
        discount_amount: discount.discountAmount,
        total: Math.max(0, subtotal + itbis - discount.discountAmount),
        pdf_path: null, // el PDF anterior mostraba "Por confirmar": se vuelve a generar al enviar
      });
      await safeLog(() => logInvoice(req, 'invoice.set_prices', updated, `Puso precios en ${docLabel(updated)}`));
      if (hasPendingPrices(invoice) && !hasPendingPrices(updated)) {
        await safeLog(async () => notifyUsers(await activeAdminIds(), {
          type: 'approval', title: '✅ Cotización lista para aprobar',
          message: `${updated.doc_number} de ${updated.client_name || 'cliente sin nombre'} ya tiene todos sus precios.`,
          link: `/cotizaciones?invoice=${updated.id}`, metadata: { invoice_id: updated.id },
        }));
      }
      return res.json({ invoice: updated });
    }
    if (isEmployee(req.user.role) && invoice.status !== 'draft') {
      return res.status(400).json({ error: 'Cannot edit a non-draft invoice' });
    }

    if (invoice.status === 'rejected') {
      return res.status(400).json({ error: 'Cannot edit a rejected invoice' });
    }

    const { type, clientName, clientPhone, notes } = req.body;
    let { items } = req.body;
    const fields = {};
    if (type)        fields.type        = type;
    if (clientName)  fields.client_name = clientName;
    if (clientPhone !== undefined) fields.client_phone = clientPhone;
    if (notes !== undefined)       fields.notes        = notes;
    else {
      const defaultNotes = 'Pago del 100% al recibir el documento finalizado.\nRetiro en tienda física en horario disponible: 9:00 a.m. a 5:30 p.m. (hora Santo Domingo, RD).';
      fields.notes = defaultNotes;
    }

    if (items && Array.isArray(items)) {
      // Una línea sin precio (o en 0) queda por confirmar y bloquea aprobar; nunca se cuela en blanco
      items = items.map((i) => (i && (i.por_confirmar || i.precio === null) ? settleLine({ ...i, por_confirmar: true }, i.precio) : i));
      const subtotal = items.reduce((s, i) => s + lineTotal(i), 0);
      const itbis    = items.some(i => i.itbis)
        ? items.reduce((s, i) => s + (i.itbis ? lineTotal(i) * 0.18 : 0), 0)
        : 0;

      // Discounts are admin-only
      let discount = { discountAmount: 0, discountType: null, discountValue: 0 };
      if (!isEmployee(req.user.role)) {
        const { discountType, discountValue, discountCode, discountReason } = req.body;
        discount = calculateDiscount({ subtotal, discountType, discountValue });
        if (discount.discountType) {
          discount.discountCode = discountCode || null;
          discount.discountReason = discountReason || null;
        }
      }

      fields.items           = JSON.stringify(items);
      fields.subtotal        = subtotal;
      fields.itbis           = itbis;
      fields.discount_type   = discount.discountType;
      fields.discount_value  = discount.discountValue;
      fields.discount_code   = discount.discountCode || null;
      fields.discount_amount = discount.discountAmount;
      fields.discount_reason = discount.discountReason || null;
      fields.total           = Math.max(0, subtotal + itbis - discount.discountAmount);
    } else if (!isEmployee(req.user.role)) {
      // Admin can update discount without changing items
      const { discountType, discountValue, discountCode, discountReason } = req.body;
      const subtotal = Number(invoice.subtotal) || 0;
      const discount = calculateDiscount({ subtotal, discountType, discountValue });
      fields.discount_type   = discount.discountType;
      fields.discount_value  = discount.discountValue;
      fields.discount_code   = discountCode || null;
      fields.discount_amount = discount.discountAmount;
      fields.discount_reason = discountReason || null;
      fields.total           = Math.max(0, subtotal + Number(invoice.itbis || 0) - discount.discountAmount);
    }

    const updated = await Invoice.update(invoice.id, fields);

    // If this invoice already had a PDF, regenerate it with the new data so the
    // preview/download always reflects the latest edit. generateInvoicePDF writes
    // to a deterministic path (<docNumber>.pdf), so the stored pdf_path stays valid.
    if (invoice.pdf_path) {
      try {
        const created = new Date(invoice.created_at || Date.now());
        const dateStr = `${String(created.getDate()).padStart(2,'0')}-${String(created.getMonth()+1).padStart(2,'0')}-${created.getFullYear()}`;
        await generateInvoicePDF({
          clientName:  updated.client_name,
          clientPhone: updated.client_phone,
          docNumber:   updated.doc_number,
          date:        dateStr,
          items:       typeof updated.items === 'string' ? JSON.parse(updated.items) : updated.items,
          notes:       updated.notes,
          type:        updated.type,
          discountType: updated.discount_type,
          discountValue: updated.discount_value,
          discountAmount: updated.discount_amount,
          discountCode: updated.discount_code,
        });
        console.log(`[Invoice] PDF regenerated after edit: ${updated.doc_number}`);
      } catch (pdfErr) {
        console.error(`[Invoice] Failed to regenerate PDF after edit for ${updated.doc_number}:`, pdfErr.message);
        // Don't fail the edit if PDF regeneration fails
      }
    }

    await safeLog(() => logInvoice(req, 'invoice.update', updated, `Editó ${docLabel(updated)} (total ${rd(invoice.total)} → ${rd(updated.total)})`, { total_antes: invoice.total }));
    res.json({ invoice: updated });
  } catch (err) {
    console.error('Update invoice error:', err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// ── DELETE /api/invoices/:id ── (admin: any | employee: own, only before it is approved)
router.delete('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (isEmployee(req.user.role)) {
      if (invoice.created_by !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (!['draft', 'pending_approval', 'rejected'].includes(invoice.status)) {
        return res.status(400).json({ error: 'Solo el admin puede eliminar un documento ya aprobado', code: 'ALREADY_APPROVED' });
      }
    }
    await Invoice.delete(invoice.id);
    await safeLog(() => logInvoice(req, 'invoice.delete', invoice, `Eliminó ${docLabel(invoice)} de ${invoice.client_name || 'cliente sin nombre'} por ${rd(invoice.total)}`));
    res.json({ message: 'Invoice deleted' });
  } catch (err) {
    console.error('Delete invoice error:', err);
    res.status(500).json({ error: 'Failed to delete invoice' });
  }
});

// ── POST /api/invoices/:id/approve ── admin only
router.post('/:id/approve', requireRole('admin'), async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!['draft', 'pending_approval'].includes(invoice.status)) {
      return res.status(400).json({ error: `Invoice is already ${invoice.status}` });
    }
    if (hasPendingPrices(invoice)) return pricesPending(res);
    const updated = await Invoice.approve(invoice.id, req.user.id);
    await safeLog(() => logInvoice(req, 'invoice.approve', updated, `Aprobó ${docLabel(updated)} por ${rd(updated.total)}`));
    await safeLog(() => notifyDecision(updated, true));
    res.json({ invoice: updated, message: 'Invoice approved' });
  } catch (err) {
    console.error('Approve invoice error:', err);
    res.status(500).json({ error: 'Failed to approve invoice' });
  }
});

// ── POST /api/invoices/:id/approve-and-send ── admin only
// Approves (if still draft / pending) and sends the quote PDF by WhatsApp. The send is exactly-once
// (see agent/delivery), so a double click or a quote already sent answers 200 { sent:false, code }.
router.post('/:id/approve-and-send', requireRole('admin'), async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'rejected') return res.status(400).json({ error: `Invoice is already ${invoice.status}` });
    if (hasPendingPrices(invoice)) return pricesPending(res);

    let approvedNow = null;
    if (['draft', 'pending_approval'].includes(invoice.status)) {
      approvedNow = await Invoice.approve(invoice.id, req.user.id); // null if a parallel click won
    }
    const result = await delivery.sendQuote(invoice.id, { actor: req.user });
    if (approvedNow) {
      await safeLog(() => notifyDecision(approvedNow, true));
      await safeLog(() => result.ok
        ? logInvoice(req, 'invoice.approve_send', approvedNow, `Aprobó y envió por WhatsApp ${docLabel(approvedNow)} por ${rd(approvedNow.total)}`)
        : logInvoice(req, 'invoice.approve', approvedNow, `Aprobó ${docLabel(approvedNow)} por ${rd(approvedNow.total)}`));
    }
    const fresh = await Invoice.findById(invoice.id);
    const body = { invoice: fresh, sent: !!result.ok };
    if (!result.ok) body.code = result.code;
    res.json(body);
  } catch (err) {
    console.error('Approve and send invoice error:', err.code || err.name);
    res.status(500).json({ error: 'Failed to approve and send invoice' });
  }
});

// ── POST /api/invoices/:id/reject ── admin only
router.post('/:id/reject', requireRole('admin'), async (req, res) => {
  try {
    const { reason } = req.body;
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!['draft', 'pending_approval'].includes(invoice.status)) {
      return res.status(400).json({ error: `Invoice is already ${invoice.status}` });
    }
    const updated = await Invoice.reject(invoice.id, req.user.id, reason);
    if (!updated) return res.status(400).json({ error: 'Failed to reject invoice' });
    await safeLog(() => logInvoice(req, 'invoice.reject', updated, `Rechazó ${docLabel(updated)}${reason ? `: ${reason}` : ''}`, { reason: reason || null }));
    await safeLog(() => notifyDecision(updated, false, reason));
    res.json({ invoice: updated, message: 'Invoice rejected' });
  } catch (err) {
    console.error('Reject invoice error:', err);
    res.status(500).json({ error: 'Failed to reject invoice' });
  }
});

// ── POST /api/invoices/:id/request-approval ── owner (employee) or admin: draft -> pending_approval
router.post('/:id/request-approval', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (invoice.status !== 'draft') {
      return res.status(400).json({ error: `Invoice is already ${invoice.status}` });
    }
    const updated = await Invoice.requestApproval(invoice.id);
    if (!updated) return res.status(400).json({ error: 'Failed to request approval' });
    await safeLog(() => logInvoice(req, 'invoice.request_approval', updated, `Pidió aprobación para ${docLabel(updated)} por ${rd(updated.total)}`));
    await safeLog(() => notifyApprovalRequested(req, updated));
    res.json({ invoice: updated, message: 'Enviada al admin para aprobación' });
  } catch (err) {
    console.error('Request approval error:', err);
    res.status(500).json({ error: 'Failed to request approval' });
  }
});

// ── POST /api/invoices/:id/send ──
// Admin can send draft/approved/pending_approval invoices directly.
// Employees: draft -> request admin approval; approved -> send; pending_approval -> wait.
router.post('/:id/send', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Employee ownership check
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (invoice.status === 'sent') {
      return res.status(400).json({ error: 'Invoice already sent' });
    }
    if (hasPendingPrices(invoice)) return pricesPending(res);

    // Employees must request admin approval before sending
    if (isEmployee(req.user.role)) {
      if (invoice.status === 'pending_approval') {
        return res.status(400).json({ error: 'Invoice is pending admin approval' });
      }
      if (invoice.status === 'draft') {
        const updated = await Invoice.requestApproval(invoice.id);
        if (!updated) return res.status(400).json({ error: 'Failed to request approval' });
        await safeLog(() => logInvoice(req, 'invoice.request_approval', updated, `Pidió aprobación para ${docLabel(updated)} por ${rd(updated.total)}`));
        await safeLog(() => notifyApprovalRequested(req, updated));
        return res.json({ invoice: updated, message: 'Invoice submitted for admin approval before sending' });
      }
      // approved -> proceed to send below
    }

    // Admin sending a pending_approval invoice implicitly approves it
    if (!isEmployee(req.user.role) && invoice.status === 'pending_approval') {
      const approvedNow = await Invoice.approve(invoice.id, req.user.id);
      await safeLog(() => notifyDecision(approvedNow, true));
    }

    // Generate PDF
    let pdfPath = invoice.pdf_path;
    let s3Key = null;
    try {
      const today = new Date();
      const dateStr = `${String(today.getDate()).padStart(2,'0')}-${String(today.getMonth()+1).padStart(2,'0')}-${today.getFullYear()}`;
      pdfPath = await generateInvoicePDF({
        clientName:  invoice.client_name,
        clientPhone: invoice.client_phone,
        docNumber:   invoice.doc_number,
        date:        dateStr,
        items:       typeof invoice.items === 'string' ? JSON.parse(invoice.items) : invoice.items,
        notes:       invoice.notes,
        type:        invoice.type,
        discountType: invoice.discount_type,
        discountValue: invoice.discount_value,
        discountAmount: invoice.discount_amount,
        discountCode: invoice.discount_code,
      });
      console.log(`[Invoice] PDF generated: ${pdfPath}`);

      // Upload to S3 if configured (backup/public access)
      if (isS3Configured() && pdfPath) {
        try {
          const key = getS3Key('invoices', `${invoice.doc_number}_${Date.now()}.pdf`);
          const upload = await uploadLocalFile(pdfPath, key, 'application/pdf');
          s3Key = upload.key;
          console.log(`[Invoice] PDF uploaded to S3: ${s3Key}`);
        } catch (s3Err) {
          console.error('[Invoice] S3 upload failed, keeping volume path:', s3Err.message);
        }
      }
    } catch (pdfErr) {
      console.error('[Invoice] PDF generation failed:', pdfErr.message);
      // Don't block sending if PDF fails — save null
      pdfPath = null;
    }

    const updated = await Invoice.markSent(invoice.id, pdfPath, s3Key, s3Key ? 's3' : 'railway_volume');
    await safeLog(() => logInvoice(req, 'invoice.send', updated, `Envió ${docLabel(updated)} a ${updated.client_name || 'cliente sin nombre'}`));
    res.json({
      invoice: updated,
      pdfPath,
      message: 'Invoice marked as sent' + (pdfPath ? '. PDF generated.' : '. PDF generation failed (saved anyway).'),
    });
  } catch (err) {
    console.error('Send invoice error:', err);
    res.status(500).json({ error: 'Failed to send invoice' });
  }
});

// ── POST /api/invoices/:id/generate-pdf ── generate/regenerate PDF for PREVIEW
// without changing status to 'sent'. Lets the employee review the document before
// deciding to send it. Owner (employee) or admin.
router.post('/:id/generate-pdf', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (blockUnapproved(req, res, invoice)) return;

    const created = new Date(invoice.created_at || Date.now());
    const dateStr = `${String(created.getDate()).padStart(2,'0')}-${String(created.getMonth()+1).padStart(2,'0')}-${created.getFullYear()}`;
    const pdfPath = await generateInvoicePDF({
      clientName:  invoice.client_name,
      clientPhone: invoice.client_phone,
      docNumber:   invoice.doc_number,
      date:        dateStr,
      items:       typeof invoice.items === 'string' ? JSON.parse(invoice.items) : invoice.items,
      notes:       invoice.notes,
      type:        invoice.type,
      discountType: invoice.discount_type,
      discountValue: invoice.discount_value,
      discountAmount: invoice.discount_amount,
      discountCode: invoice.discount_code,
    });

    const updated = await Invoice.update(invoice.id, { pdf_path: pdfPath, pdf_storage_type: 'railway_volume' });
    res.json({ invoice: updated, pdfPath, message: 'PDF generated (preview, not sent).' });
  } catch (err) {
    console.error('Generate PDF error:', err);
    res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
  }
});

// ── POST /api/invoices/:id/send-whatsapp ── send the PDF to the client's WhatsApp chat.
// Nothing is sent automatically. Employees can only send their own quotes once an admin approved
// them; the admin can send directly (which approves it). A rejected quote is never sent.
// The send goes through the delivery service (agent/delivery): the first send is exactly-once
// (sent_by_bot_at claim, send_error cleared, message + Actividad recorded, WINDOW_CLOSED notice).
// A quote the service already sent only goes out again with body { resend: true }, which the panel
// sends after its confirm dialog (so a double click never resends); that path also records the
// message and Actividad and clears send_error. Answers 200 { invoice, sent, code? }.
router.post('/:id/send-whatsapp', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (invoice.status === 'rejected') {
      return res.status(400).json({ error: 'Este documento fue rechazado; corrígelo antes de enviarlo', code: 'REJECTED' });
    }
    if (hasPendingPrices(invoice)) return pricesPending(res);
    if (isEmployee(req.user.role) && !['approved', 'sent', 'paid'].includes(invoice.status)) {
      return res.status(403).json({ error: 'El admin debe aprobar este documento antes de enviarlo al cliente', code: 'APPROVAL_REQUIRED' });
    }
    if (!invoice.client_phone) return res.status(400).json({ error: 'Invoice has no client phone', code: 'NO_PHONE' });
    if (!isEmployee(req.user.role) && ['draft', 'pending_approval'].includes(invoice.status)) {
      await Invoice.approve(invoice.id, req.user.id);
    }

    const result = invoice.sent_by_bot_at && req.body?.resend === true
      ? await delivery.resendQuote(invoice.id, { actor: req.user })
      : await delivery.sendQuote(invoice.id, { actor: req.user });
    const fresh = await Invoice.findById(invoice.id);
    const body = { invoice: fresh, sent: !!result.ok };
    if (result.ok) body.message = `Invoice sent via WhatsApp to ${invoice.client_phone}`;
    else body.code = result.code;
    res.json(body);
  } catch (err) {
    console.error('Send WhatsApp invoice error:', err.code || err.name);
    res.status(500).json({ error: 'Failed to send invoice via WhatsApp' });
  }
});

// ── GET /api/invoices/:id/pdf ── serve the PDF file
router.get('/:id/pdf', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (blockUnapproved(req, res, invoice)) return;
    if (!invoice.pdf_path) {
      return res.status(404).json({ error: 'PDF not yet generated. Send the invoice first.' });
    }

    // If PDF has an S3 key, redirect to signed URL
    if (invoice.pdf_s3_key) {
      try {
        const signedUrl = await getSignedDownloadUrl(invoice.pdf_s3_key);
        return res.redirect(signedUrl);
      } catch (s3Err) {
        console.error('[Invoice] Failed to generate S3 signed URL:', s3Err.message);
        // Fall through to volume/local file
      }
    }

    const absPath = path.resolve(invoice.pdf_path);
    const allowedRoots = [
      path.resolve(__dirname, '..', '..', 'public', 'invoices'),
      path.resolve(storage.getStorageRoot()),
    ];
    if (!allowedRoots.some((root) => absPath.startsWith(root))) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${invoice.doc_number}.pdf"`);
    res.sendFile(absPath);
  } catch (err) {
    console.error('Serve PDF error:', err);
    res.status(500).json({ error: 'Failed to serve PDF' });
  }
});

// ── POST /api/invoices/:id/confirm-payment ── admin only
// Confirms client payment. If the invoice is linked to a case, the case is closed as paid.
router.post('/:id/confirm-payment', requireRole('admin'), async (req, res) => {
  try {
    const { payment_method, payment_reference } = req.body;
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'paid') {
      return res.status(400).json({ error: 'Invoice is already paid' });
    }
    if (!['approved', 'sent'].includes(invoice.status)) {
      return res.status(400).json({ error: 'Invoice must be approved or sent before payment' });
    }

    const updated = await Invoice.confirmPayment(req.params.id, {
      paidBy: req.user.id,
      paymentMethod: payment_method,
      paymentReference: payment_reference,
    });

    // Update related case status
    if (updated && updated.case_id) {
      const relatedCase = await Case.findById(updated.case_id);
      const newCaseStatus = relatedCase && relatedCase.case_type === 'certificacion'
        ? 'in_progress'
        : 'paid';

      await pool.query(
        `UPDATE cases SET status=$1, updated_at=NOW() WHERE id=$2`,
        [newCaseStatus, updated.case_id]
      );

      await Case.addStatusHistory({
        caseId: updated.case_id,
        status: newCaseStatus,
        changedByUserId: req.user.id,
        notes: `Pago confirmado para ${invoice.doc_number}`,
      });

      console.log(`[Invoices] Related case #${updated.case_id} updated to ${newCaseStatus}`);
    }

    await safeLog(() => logInvoice(req, 'invoice.payment', updated, `Confirmó el pago de ${docLabel(updated)} por ${rd(updated.total)}${payment_reference ? ` (ref. ${payment_reference})` : ''}`, { payment_method: payment_method || null, payment_reference: payment_reference || null }));
    // Documents waiting for payment go out now; a failure never undoes the confirmed payment.
    let documentsSent = 0;
    try {
      documentsSent = await delivery.deliverPaidDocuments(updated.id, { actor: req.user });
    } catch (err) {
      console.error('Deliver paid documents error:', err.code || 'UNKNOWN', 'invoice', updated.id);
    }
    res.json({ invoice: updated, documents_sent: documentsSent, message: 'Payment confirmed. Case updated if linked.' });
  } catch (err) {
    console.error('Confirm payment error:', err);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

module.exports = router;
