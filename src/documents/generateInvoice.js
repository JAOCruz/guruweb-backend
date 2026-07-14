/**
 * Guru Soluciones — Generador de Facturas / Cotizaciones PDF
 * Recrea el estilo de FACTURA_DEFINITIVA.pdf usando HTML + weasyprint
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const storage = require('../utils/storage');

const LOGO_PATH = path.resolve(__dirname, '../../public/assets/logo.png');
const HEADER_IMG_PATH = path.resolve(__dirname, '../../public/assets/header.jpeg');
const OUT_DIR = storage.getDir('invoices');

const fmt = (n) => `RD$ ${n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function toBase64(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
}

function fileUrl(filePath) {
  if (!fs.existsSync(filePath)) return '';
  return 'file://' + filePath;
}

/**
 * Genera un PDF de cotización/factura con estilo FACTURA_DEFINITIVA
 */
async function generateInvoicePDF({ clientName, clientPhone, docNumber, date, items, notes, type = 'COTIZACIÓN' }) {
  const subtotal = items.reduce((s, i) => s + (i.cantidad * i.precio), 0);
  const itbis = items.some(i => i.itbis)
    ? items.reduce((s, i) => s + (i.itbis ? i.cantidad * i.precio * 0.18 : 0), 0)
    : 0;
  const total = subtotal + itbis;

  // Build item rows — pad to at least 6 rows like the template
  const paddedItems = [...items];
  while (paddedItems.length < 6) {
    paddedItems.push({ desc: '', cantidad: '', precio: '', monto: '' });
  }

  const itemsHTML = paddedItems.map((item, i) => {
    const isEmpty = !item.desc;
    const desc = isEmpty ? '&nbsp;' : String(item.desc).substring(0, 90);
    const qty = isEmpty ? '' : item.cantidad;
    const price = isEmpty ? '' : fmt(item.precio);
    const amount = isEmpty ? '' : fmt(item.cantidad * item.precio);
    return `
    <tr class="item-row ${isEmpty ? 'empty' : ''}">
      <td class="num">${isEmpty ? '' : i + 1}</td>
      <td class="desc">${desc}</td>
      <td class="qty">${qty}</td>
      <td class="price">${price}</td>
      <td class="amount">${amount}</td>
    </tr>`;
  }).join('');

  const headerBase64 = toBase64(HEADER_IMG_PATH) || toBase64(LOGO_PATH);
  const logoBase64 = toBase64(LOGO_PATH);

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>${docNumber}</title>
<style>
  @page {
    size: letter;
    margin: 0;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
    font-size: 11pt;
    color: #1a1a1a;
    line-height: 1.3;
    background: #fff;
  }

  .page {
    width: 8.5in;
    min-height: 11in;
    padding: 0.4in 0.5in 0.5in 0.5in;
    position: relative;
  }

  /* ── HEADER ── */
  .header-img {
    max-width: 100%;
    max-height: 2.5in;
    width: auto;
    height: auto;
    display: block;
    margin: 0 auto 0.12in auto;
  }

  .header-fallback {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 0.15in;
    padding-bottom: 0.1in;
    border-bottom: 2px solid #1a365d;
  }
  .header-fallback img {
    width: 80px;
    height: 80px;
    object-fit: contain;
  }
  .header-fallback .company-name {
    font-size: 20pt;
    font-weight: 700;
    color: #1a365d;
  }
  .header-fallback .company-tagline {
    font-size: 9pt;
    color: #4a5568;
  }

  /* ── META ROW ── */
  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    margin-bottom: 0.2in;
  }
  .doc-type-badge {
    background: #1a365d;
    color: #fff;
    padding: 4px 14px;
    font-size: 10pt;
    font-weight: 700;
    letter-spacing: 1px;
    text-transform: uppercase;
    border-radius: 3px;
  }
  .doc-number {
    font-size: 14pt;
    font-weight: 700;
    color: #1a365d;
    text-align: right;
  }
  .doc-date {
    font-size: 10pt;
    color: #4a5568;
    text-align: right;
    margin-top: 2px;
  }

  /* ── CLIENTE ── */
  .client-block {
    margin-bottom: 0.2in;
  }
  .field-row {
    display: flex;
    align-items: baseline;
    margin-bottom: 6px;
    font-size: 10.5pt;
  }
  .field-label {
    font-weight: 700;
    color: #1a365d;
    min-width: 90px;
    text-transform: uppercase;
    font-size: 9.5pt;
    letter-spacing: 0.5px;
  }
  .field-value {
    flex: 1;
    border-bottom: 1px solid #1a365d;
    padding-left: 6px;
    padding-bottom: 1px;
    font-weight: 600;
    color: #1a1a1a;
  }

  /* ── ITEMS TABLE ── */
  .items-table {
    width: 100%;
    border-collapse: collapse;
    margin: 0.15in 0 0.1in 0;
    font-size: 10pt;
  }
  .items-table thead th {
    background: #1a365d;
    color: #fff;
    padding: 7px 8px;
    font-weight: 700;
    font-size: 9pt;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    text-align: center;
    border: 1px solid #1a365d;
  }
  .items-table thead th.desc-col {
    text-align: left;
    width: 46%;
  }
  .items-table thead th.num-col { width: 6%; }
  .items-table thead th.qty-col { width: 10%; }
  .items-table thead th.price-col { width: 19%; }
  .items-table thead th.amount-col { width: 19%; }

  .items-table tbody td {
    padding: 8px;
    border: 1px solid #cbd5e0;
    vertical-align: top;
    height: 28px;
  }
  .items-table tbody tr.empty td {
    border-bottom: 1px solid #e2e8f0;
    color: transparent;
  }
  .items-table tbody td.num {
    text-align: center;
    font-weight: 600;
    color: #4a5568;
  }
  .items-table tbody td.desc {
    text-align: left;
    font-weight: 500;
  }
  .items-table tbody td.qty {
    text-align: center;
    font-weight: 600;
  }
  .items-table tbody td.price,
  .items-table tbody td.amount {
    text-align: right;
    font-weight: 600;
    font-family: 'Courier New', monospace;
    font-size: 9.5pt;
  }
  .items-table tbody td.amount {
    color: #1a365d;
    font-weight: 700;
  }

  /* ── TOTALS ── */
  .totals-block {
    display: flex;
    justify-content: flex-end;
    margin-top: 0.1in;
  }
  .totals-table {
    border-collapse: collapse;
    font-size: 10.5pt;
    width: 280px;
  }
  .totals-table td {
    padding: 5px 10px;
    border: 1px solid #cbd5e0;
  }
  .totals-table .label {
    text-align: left;
    font-weight: 600;
    color: #4a5568;
    background: #f7fafc;
  }
  .totals-table .value {
    text-align: right;
    font-weight: 700;
    font-family: 'Courier New', monospace;
    font-size: 10pt;
    min-width: 120px;
  }
  .totals-table .grand-total td {
    background: #1a365d;
    color: #fff;
    font-size: 11pt;
    font-weight: 700;
    border: 1px solid #1a365d;
  }
  .totals-table .grand-total .value {
    color: #fff;
    font-size: 12pt;
  }

  /* ── NOTES ── */
  .notes-block {
    margin-top: 0.15in;
    border: 1px solid #cbd5e0;
    padding: 10px 12px;
    background: #fffaf0;
    min-height: 0.6in;
  }
  .notes-label {
    font-size: 8pt;
    font-weight: 700;
    text-transform: uppercase;
    color: #744210;
    margin-bottom: 4px;
    letter-spacing: 0.5px;
  }
  .notes-text {
    font-size: 9.5pt;
    color: #553c22;
    line-height: 1.45;
  }

  /* ── FOOTER ── */
  .footer-line {
    margin-top: 0.2in;
    border-top: 2px solid #1a365d;
    padding-top: 8px;
    font-size: 8pt;
    color: #718096;
    text-align: center;
  }

  /* ── PRINT FIXES ── */
  @media print {
    .page { page-break-after: always; }
    .page:last-child { page-break-after: auto; }
  }
</style>
</head>
<body>

<div class="page">

  <!-- HEADER -->
  ${headerBase64
    ? `<img src="${fileUrl(HEADER_IMG_PATH)}" class="header-img" alt="Guru Soluciones">`
    : logoBase64
      ? `<div class="header-fallback">
           <img src="${fileUrl(LOGO_PATH)}" alt="Logo">
           <div>
             <div class="company-name">Gurú Soluciones</div>
             <div class="company-tagline">Tu solución legal de confianza 🦉</div>
           </div>
         </div>`
      : `<div class="header-fallback">
           <div class="company-name">Gurú Soluciones</div>
           <div class="company-tagline">Tu solución legal de confianza 🦉</div>
         </div>`}

  <!-- DOC TYPE + NUMBER -->
  <div class="meta-row">
    <div class="doc-type-badge">${type}</div>
    <div>
      <div class="doc-number">${docNumber}</div>
      <div class="doc-date">FECHA: ${date}</div>
    </div>
  </div>

  <!-- CLIENTE -->
  <div class="client-block">
    <div class="field-row">
      <span class="field-label">CLIENTE:</span>
      <span class="field-value">${clientName}</span>
    </div>
    ${clientPhone ? `
    <div class="field-row">
      <span class="field-label">TELÉFONO:</span>
      <span class="field-value">${clientPhone}</span>
    </div>` : ''}
  </div>

  <!-- ITEMS TABLE -->
  <table class="items-table">
    <thead>
      <tr>
        <th class="num-col">NUM</th>
        <th class="desc-col">DESCRIPCIÓN</th>
        <th class="qty-col">CANT</th>
        <th class="price-col">PRECIO UNIT.</th>
        <th class="amount-col">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHTML}
    </tbody>
  </table>

  <!-- TOTALS -->
  <div class="totals-block">
    <table class="totals-table">
      <tr>
        <td class="label">SUB-TOTAL</td>
        <td class="value">${fmt(subtotal)}</td>
      </tr>
      ${itbis > 0 ? `
      <tr>
        <td class="label">ITBIS (18%)</td>
        <td class="value">${fmt(itbis)}</td>
      </tr>` : ''}
      <tr class="grand-total">
        <td class="label">TOTAL A PAGAR</td>
        <td class="value">${fmt(total)}</td>
      </tr>
    </table>
  </div>

  <!-- NOTES -->
  ${notes ? `
  <div class="notes-block">
    <div class="notes-label">NOTAS (OBSERVACIONES)</div>
    <div class="notes-text">${notes.replace(/\n/g, '<br>')}</div>
  </div>` : ''}

  <!-- FOOTER -->
  <div class="footer-line">
    Este documento es una ${type.toLowerCase()} y no constituye comprobante fiscal.
    Válido por 72 horas desde la fecha de emisión. Precios sujetos a Ley 140-15.
    Gurú Soluciones — La Feria, Santo Domingo, Rep. Dom.
  </div>

</div>

</body>
</html>`;

  const safeDocNumber = docNumber.replace(/[^a-zA-Z0-9-]/g, '_');
  const tmpHtml = path.join(OUT_DIR, `${safeDocNumber}.html`);
  const outPdf = path.join(OUT_DIR, `${safeDocNumber}.pdf`);

  fs.writeFileSync(tmpHtml, html);

  try {
    console.log(`[PDF] Generating: ${outPdf}`);
    // Security: use spawnSync with argument arrays instead of execSync with string interpolation
    const script = `
import sys
import weasyprint
weasyprint.HTML(filename=sys.argv[1]).write_pdf(sys.argv[2])
`;
    const result = spawnSync('python3', ['-c', script, tmpHtml, outPdf], {
      timeout: 30000,
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || `weasyprint exited with code ${result.status}`);
    }
    console.log(`[PDF] ✅ Generated: ${outPdf}`);
  } catch (err) {
    console.error(`[PDF] Failed:`, err.message);
    fs.unlinkSync(tmpHtml);
    throw err;
  }

  fs.unlinkSync(tmpHtml);
  return outPdf;
}

/**
 * DEPRECATED: Template overlay method is unreliable.
 * Always falls back to generateInvoicePDF for consistent output.
 */
async function generateInvoiceFromTemplate(opts) {
  console.log('[PDF] Template overlay deprecated, using HTML generation');
  return generateInvoicePDF(opts);
}

/**
 * Auto-generate a document number
 */
function generateDocNumber(type = 'COT') {
  const now = new Date();
  const year = now.getFullYear();
  const seq = String(now.getTime()).slice(-4);
  return `${type}-${year}-${seq}`;
}

module.exports = { generateInvoicePDF, generateInvoiceFromTemplate, generateDocNumber };
