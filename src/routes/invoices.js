const express = require('express');
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

// ── GET /api/invoices ── list (admin: all | digitador: own)
router.get('/', async (req, res) => {
  try {
    const invoices = !isEmployee(req.user.role)
      ? await Invoice.findAll()
      : await Invoice.findByCreator(req.user.id);
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

    // Close related case as paid
    if (updated && updated.case_id) {
      await pool.query(
        `UPDATE cases SET status='paid', updated_at=NOW() WHERE id=$1`,
        [updated.case_id]
      );
      console.log(`[Invoices] Related case #${updated.case_id} closed as paid`);
    }

    res.json({ invoice: updated, message: 'Payment confirmed. Case closed if linked.' });
  } catch (err) {
    console.error('Confirm payment error:', err);
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

module.exports = router;
