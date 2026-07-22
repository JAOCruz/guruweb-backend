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
const Invoice = require('../models/Invoice');
const { generateInvoicePDF, generateDocNumber } = require('../documents/generateInvoice');

const Case = require('../models/Case');
const Client = require('../models/Client');
const Message = require('../models/Message');
const { sendDocumentToChat } = require('../whatsapp/sender');

const router = express.Router();

// ── get all quotations (auth required) ──
router.get('/quotations', authenticate, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT i.*,
             cb.name AS created_by_name
      FROM invoices i
      LEFT JOIN users cb ON cb.id = i.created_by
      WHERE i.type = 'COTIZACIÓN'
      ORDER BY i.created_at DESC
      LIMIT 50
    `);
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
router.get('/pdf/:filename', authenticate, (req, res) => {
  try {
    const filename = path.basename(req.params.filename); // Prevent directory traversal

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

// ── GET /api/invoices ── list (admin: all | digitador/auxiliar: assigned clients or own)
router.get('/', async (req, res) => {
  try {
    const invoices = !isEmployee(req.user.role)
      ? await Invoice.findAll()
      : await Invoice.findByAssignedTo(req.user.id);
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
    // Employee can only see own invoices
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
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
    const total = subtotal + itbis;

    const docNumber = generateDocNumber(type === 'FACTURA' ? 'FAC' : 'COT');

    const invoice = await Invoice.create({
      docNumber, type: type || 'COTIZACIÓN',
      clientId: clientId || null, clientName, clientPhone,
      items, notes: finalNotes, subtotal, itbis, total,
      createdBy: req.user.id,
    });

    res.status(201).json({ invoice });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Doc number already exists' });
    console.error('Create invoice error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// ── PUT /api/invoices/:id ── edit (draft only, own or admin)
router.put('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    if (isEmployee(req.user.role)) {
      if (invoice.created_by !== req.user.id) return res.status(403).json({ error: 'Access denied' });
      if (invoice.status !== 'draft') return res.status(400).json({ error: 'Cannot edit a non-draft invoice' });
    }

    const { type, clientName, clientPhone, items, notes } = req.body;
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
      const subtotal = items.reduce((s, i) => s + (Number(i.cantidad) * Number(i.precio)), 0);
      const itbis    = items.some(i => i.itbis)
        ? items.reduce((s, i) => s + (i.itbis ? Number(i.cantidad) * Number(i.precio) * 0.18 : 0), 0)
        : 0;
      fields.items    = JSON.stringify(items);
      fields.subtotal = subtotal;
      fields.itbis    = itbis;
      fields.total    = subtotal + itbis;
    }

    const updated = await Invoice.update(invoice.id, fields);
    res.json({ invoice: updated });
  } catch (err) {
    console.error('Update invoice error:', err);
    res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// ── DELETE /api/invoices/:id ── (draft only, admin or creator)
router.delete('/:id', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }
    if (invoice.status === 'sent') {
      return res.status(400).json({ error: 'Cannot delete a sent invoice' });
    }
    await Invoice.delete(invoice.id);
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
    if (invoice.status !== 'draft') {
      return res.status(400).json({ error: `Invoice is already ${invoice.status}` });
    }
    const updated = await Invoice.approve(invoice.id, req.user.id);
    res.json({ invoice: updated, message: 'Invoice approved' });
  } catch (err) {
    console.error('Approve invoice error:', err);
    res.status(500).json({ error: 'Failed to approve invoice' });
  }
});

// ── POST /api/invoices/:id/send ── admin can always; digitador only if approved
router.post('/:id/send', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Employee ownership check
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Employee can only send approved invoices
    if (isEmployee(req.user.role) && invoice.status !== 'approved') {
      return res.status(403).json({ error: 'Invoice must be approved by admin before sending' });
    }

    if (invoice.status === 'sent') {
      return res.status(400).json({ error: 'Invoice already sent' });
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
    });

    const updated = await Invoice.update(invoice.id, { pdf_path: pdfPath, pdf_storage_type: 'railway_volume' });
    res.json({ invoice: updated, pdfPath, message: 'PDF generated (preview, not sent).' });
  } catch (err) {
    console.error('Generate PDF error:', err);
    res.status(500).json({ error: 'Failed to generate PDF: ' + err.message });
  }
});

// ── POST /api/invoices/:id/send-whatsapp ── generate PDF (if needed) and send it
// to the client's WhatsApp chat. This is the manual "employee confirms and sends"
// step — nothing is sent automatically. Owner (employee) or admin.
router.post('/:id/send-whatsapp', async (req, res) => {
  try {
    const invoice = await Invoice.findById(req.params.id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (isEmployee(req.user.role) && invoice.created_by !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Ensure PDF exists (generate if missing or file gone)
    let pdfPath = invoice.pdf_path;
    if (!pdfPath || !fs.existsSync(pdfPath)) {
      const created = new Date(invoice.created_at || Date.now());
      const dateStr = `${String(created.getDate()).padStart(2,'0')}-${String(created.getMonth()+1).padStart(2,'0')}-${created.getFullYear()}`;
      pdfPath = await generateInvoicePDF({
        clientName:  invoice.client_name,
        clientPhone: invoice.client_phone,
        docNumber:   invoice.doc_number,
        date:        dateStr,
        items:       typeof invoice.items === 'string' ? JSON.parse(invoice.items) : invoice.items,
        notes:       invoice.notes,
        type:        invoice.type,
      });
    }

    // Resolve the chat JID (handles @lid privacy accounts via last known JID)
    const phone = invoice.client_phone;
    if (!phone) return res.status(400).json({ error: 'Invoice has no client phone' });
    const jid = (await Message.getLastJid(phone)) || `${phone}@s.whatsapp.net`;

    await sendDocumentToChat(jid, pdfPath, `${invoice.doc_number}.pdf`);

    const updated = await Invoice.markSent(
      invoice.id, pdfPath, invoice.pdf_s3_key || null, invoice.pdf_s3_key ? 's3' : 'railway_volume'
    );
    res.json({ invoice: updated, message: `Invoice sent via WhatsApp to ${phone}` });
  } catch (err) {
    console.error('Send WhatsApp invoice error:', err);
    res.status(500).json({ error: 'Failed to send invoice via WhatsApp: ' + err.message });
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

    res.json({ invoice: updated, message: 'Payment confirmed. Case updated if linked.' });
  } catch (err) {
    console.error('Confirm payment error:', err);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

module.exports = router;
