/**
 * Guru Soluciones — Generador de Facturas / Cotizaciones PDF
 * Recrea el estilo de FACTURA_DEFINITIVA.pdf usando HTML + weasyprint
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const storage = require('../utils/storage');

const LOGO_PATH = path.resolve(__dirname, '../../public/assets/logo.png');
const OUT_DIR = storage.getDir('invoices');

const fmt = (n) => `RD$ ${Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Strip emojis and other symbols the PDF fonts can't render
const clean = (s) => String(s)
  .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{2190}-\u{21FF}\u{2300}-\u{23FF}]/gu, '')
  .replace(/[ \t]{2,}/g, ' ')
  .trim();

function toBase64(filePath) {
  if (!fs.existsSync(filePath)) return '';
  const ext = path.extname(filePath).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
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
    paddedItems.push({ desc: '', cantidad: '', precio: '' });
  }

  const itemsHTML = paddedItems.map((item, i) => {
    const isEmpty = !item.desc;
    let desc = isEmpty ? '&nbsp;' : clean(item.desc).substring(0, 90);
    if (!isEmpty && Number(item.cantidad) > 1) desc += ` (x${item.cantidad})`;
    const price = isEmpty ? '' : fmt(item.precio);
    const amount = isEmpty ? '' : fmt(item.cantidad * item.precio);
    return `
    <tr>
      <td class="num">${isEmpty ? '&nbsp;' : i + 1}</td>
      <td class="desc">${desc}</td>
      <td class="price">${isEmpty ? '&nbsp;' : price}</td>
      <td class="amount">${isEmpty ? '&nbsp;' : amount}</td>
    </tr>`;
  }).join('');

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
    color: #000;
    line-height: 1.3;
    background: #fff;
  }

  .page {
    width: 8.5in;
    min-height: 11in;
    padding: 0.45in 1in 0.5in 1in;
    position: relative;
  }

  /* ── HEADER ── */
  .doc-ref {
    position: absolute;
    top: 0.45in;
    right: 1in;
    text-align: right;
    font-size: 9pt;
    color: #666;
    line-height: 1.4;
  }
  .doc-ref .ref-type {
    font-weight: 700;
    color: #333;
    letter-spacing: 1px;
  }

  .logo-block {
    text-align: center;
    margin-bottom: 0.22in;
  }
  .logo-block img {
    width: 4.2in;
    height: auto;
  }
  .company-line {
    font-size: 10pt;
    font-weight: 700;
    letter-spacing: 0.5px;
    margin-top: 6px;
  }
  .rnc-line {
    font-size: 11pt;
    font-weight: 700;
    letter-spacing: 3px;
    margin-top: 2px;
  }

  /* ── FIELDS (FECHA / CLIENTE / RNC) ── */
  .fields-table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 0.22in;
  }
  .fields-table td {
    padding: 0 0 2px 0;
    vertical-align: bottom;
  }
  .fields-table tr { height: 0.34in; }
  .fields-table td.field-label {
    font-weight: 700;
    font-size: 11pt;
    white-space: nowrap;
    width: 1%;
    padding-right: 4px;
  }
  .fields-table td.field-line {
    border-bottom: 1px solid #000;
    font-weight: 600;
    font-size: 11pt;
    padding-left: 6px;
    width: 99%;
  }

  /* ── ITEMS TABLE ── */
  .items-table {
    width: 100%;
    border-collapse: collapse;
    border: 1.5px solid #000;
  }
  .items-table thead th {
    background: #000;
    color: #fff;
    font-weight: 700;
    font-size: 12pt;
    text-align: center;
    vertical-align: middle;
    padding: 14px 8px;
    border: 1px solid #000;
    line-height: 1.25;
  }
  .items-table thead th.num-col { width: 9%; }
  .items-table thead th.desc-col { width: 49%; }
  .items-table thead th.price-col { width: 21%; }
  .items-table thead th.amount-col { width: 21%; }

  .items-table tbody td {
    border: 1px solid #000;
    padding: 6px 8px;
    height: 0.38in;
    vertical-align: middle;
    font-size: 10.5pt;
  }
  .items-table tbody td.num {
    text-align: center;
    font-weight: 600;
  }
  .items-table tbody td.desc {
    text-align: left;
    font-weight: 500;
  }
  .items-table tbody td.price,
  .items-table tbody td.amount {
    text-align: right;
    font-weight: 600;
  }

  /* ── NOTES + TOTALS (fila final combinada) ── */
  .items-table tbody td.notes-cell {
    vertical-align: top;
    height: 1.0in;
    padding: 8px 10px;
  }
  .notes-label {
    font-weight: 700;
    font-size: 10.5pt;
  }
  .notes-text {
    margin-top: 6px;
    font-size: 9.5pt;
    font-weight: 400;
    line-height: 1.4;
  }
  .items-table tbody td.totals-cell {
    background: #000;
    padding: 8px 14px;
    vertical-align: top;
  }
  .totals-inner {
    width: 100%;
    border-collapse: collapse;
  }
  .totals-inner td {
    border: none;
    padding: 3px 0;
    font-size: 10.5pt;
    font-weight: 700;
    white-space: nowrap;
  }
  .totals-inner .t-label { text-align: left; padding-right: 12px; }
  .totals-inner .t-value { text-align: right; }
  .totals-inner .row-subtotal .t-label,
  .totals-inner .row-subtotal .t-value { color: #fff; }
  .totals-inner .row-itbis .t-label { color: #2e5ce6; }
  .totals-inner .row-itbis .t-value { color: #fff; }
  .totals-inner .row-credito .t-label,
  .totals-inner .row-credito .t-value { color: #d32f2f; }
  .totals-inner .row-total .t-label,
  .totals-inner .row-total .t-value { color: #1f9d4d; }

  /* ── FIRMA / SELLO ── */
  .signature-block {
    margin-top: 0.5in;
    text-align: center;
  }
  .signature-line {
    width: 2.6in;
    margin: 0 auto;
    border-top: 1px dashed #000;
    padding-top: 4px;
    font-size: 11pt;
  }
  .sello-text {
    margin-top: 0.35in;
    margin-left: 0.3in;
    text-align: left;
    color: #b9b9e6;
    font-size: 12pt;
    letter-spacing: 8px;
  }
</style>
</head>
<body>

<div class="page">

  <!-- DOC REF (tipo + número) -->
  <div class="doc-ref">
    <div class="ref-type">${type}</div>
    <div>${docNumber}</div>
  </div>

  <!-- HEADER -->
  <div class="logo-block">
    ${logoBase64 ? `<img src="${logoBase64}" alt="Gurú Soluciones">` : ''}
    <div class="company-line">GRUPO UNIDO DE REDACTORES UNIVERSALES, GRUNID, SRL</div>
    <div class="rnc-line">RNC.: 1-33-52409-2</div>
  </div>

  <!-- FIELDS -->
  <table class="fields-table">
    <tr>
      <td class="field-label">FECHA:</td>
      <td class="field-line">${date || '&nbsp;'}</td>
    </tr>
    <tr>
      <td class="field-label">CLIENTE:</td>
      <td class="field-line">${clientName || '&nbsp;'}</td>
    </tr>
    <tr>
      <td class="field-label">RNC:</td>
      <td class="field-line">&nbsp;</td>
    </tr>
  </table>

  <!-- ITEMS TABLE -->
  <table class="items-table">
    <thead>
      <tr>
        <th class="num-col">NUM.</th>
        <th class="desc-col">DESCRIPCION</th>
        <th class="price-col">PRECIO<br>UNITARIO</th>
        <th class="amount-col">TOTAL</th>
      </tr>
    </thead>
    <tbody>
      ${itemsHTML}
      <tr>
        <td class="notes-cell" colspan="2">
          <div class="notes-label">NOTAS (OBSERVACIONES):</div>
          ${notes ? `<div class="notes-text">${clean(notes).replace(/\n/g, '<br>')}</div>` : ''}
        </td>
        <td class="totals-cell" colspan="2">
          <table class="totals-inner">
            <tr class="row-subtotal">
              <td class="t-label">SUB-TOTAL</td>
              <td class="t-value">${fmt(subtotal)}</td>
            </tr>
            <tr class="row-itbis">
              <td class="t-label">ITBIS</td>
              <td class="t-value">${fmt(itbis)}</td>
            </tr>
            <tr class="row-credito">
              <td class="t-label">CREDITO</td>
              <td class="t-value">${fmt(0)}</td>
            </tr>
            <tr class="row-total">
              <td class="t-label">TOTAL GENERAL</td>
              <td class="t-value">${fmt(total)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </tbody>
  </table>

  <!-- FIRMA -->
  <div class="signature-block">
    <div class="signature-line">Entregado por:</div>
  </div>

  <!-- SELLO -->
  <div class="sello-text">( SELLO )</div>

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
