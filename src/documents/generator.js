/**
 * Document Generator
 * Fills .docx templates with client data using docxtemplater
 * Falls back to python-docx text replacement for complex cases
 */

const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const TEMPLATES_DIR = path.join(__dirname, '../../templates/generated');
const OUTPUT_DIR = path.join(__dirname, '../../templates/output');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Convert number to Spanish text for legal documents
 */
function numberToSpanish(n) {
  const units = ['', 'UN', 'DOS', 'TRES', 'CUATRO', 'CINCO', 'SEIS', 'SIETE', 'OCHO', 'NUEVE',
    'DIEZ', 'ONCE', 'DOCE', 'TRECE', 'CATORCE', 'QUINCE', 'DIECISEIS', 'DIECISIETE', 'DIECIOCHO', 'DIECINUEVE'];
  const tens = ['', '', 'VEINTE', 'TREINTA', 'CUARENTA', 'CINCUENTA', 'SESENTA', 'SETENTA', 'OCHENTA', 'NOVENTA'];
  const hundreds = ['', 'CIEN', 'DOSCIENTOS', 'TRESCIENTOS', 'CUATROCIENTOS', 'QUINIENTOS',
    'SEISCIENTOS', 'SETECIENTOS', 'OCHOCIENTOS', 'NOVECIENTOS'];
  
  n = Math.round(n);
  if (n === 0) return 'CERO';
  if (n < 20) return units[n];
  if (n < 100) return tens[Math.floor(n/10)] + (n%10 ? ' Y ' + units[n%10] : '');
  if (n < 1000) return hundreds[Math.floor(n/100)] + (n%100 ? ' ' + numberToSpanish(n%100) : '');
  if (n < 1000000) {
    const thou = Math.floor(n/1000);
    return (thou === 1 ? 'MIL' : numberToSpanish(thou) + ' MIL') + (n%1000 ? ' ' + numberToSpanish(n%1000) : '');
  }
  return n.toString();
}

function formatMoney(amount) {
  const n = parseFloat(String(amount).replace(/[^0-9.]/g, ''));
  const text = numberToSpanish(Math.round(n));
  const formatted = n.toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${text} PESOS DOMINICANOS (RD$ ${formatted})`;
}

function formatDate(date = new Date()) {
  const days = ['', 'primero', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
    'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte',
    'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve', 'treinta', 'treinta y uno'];
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const yearWords = {
    2024: 'dos mil veinticuatro', 2025: 'dos mil veinticinco', 2026: 'dos mil veintiséis',
    2027: 'dos mil veintisiete', 2028: 'dos mil veintiocho'
  };
  const d = date.getDate();
  const m = date.getMonth();
  const y = date.getFullYear();
  const dayNum = `(${String(d).padStart(2, '0')})`;
  return `${days[d]} ${dayNum} días del mes de ${months[m]} del año ${yearWords[y] || y} (${y})`;
}

/**
 * Prepare data object for a template
 */
function prepareData(templateKey, raw) {
  const today = new Date();
  const base = {
    fecha_contrato: formatDate(today),
    notario_nombre: 'DR. RAMON ANIBAL GUZMAN MENDEZ',
    notario_matricula: '4745',
    ciudad: 'Santo Domingo, Distrito Nacional, capital de la República Dominicana',
  };

  if (templateKey === 'contrato_alquiler_vivienda' || templateKey === 'contrato_alquiler_comercial') {
    const propGenero = (raw.propietario_genero || 'M').toUpperCase() === 'F';
    const inqGenero = (raw.inquilino_genero || 'M').toUpperCase() === 'F';
    return {
      ...base,
      propietario_nombre: (raw.propietario_nombre || '').toUpperCase(),
      propietario_cedula: raw.propietario_cedula || '',
      propietario_role: propGenero ? 'LA PROPIETARIA' : 'EL PROPIETARIO',
      propietario_art: propGenero ? 'la señora' : 'el señor',
      inquilino_nombre: (raw.inquilino_nombre || '').toUpperCase(),
      inquilino_cedula: raw.inquilino_cedula || '',
      inquilino_role: inqGenero ? 'LA INQUILINA' : 'EL INQUILINO',
      inquilino_art: inqGenero ? 'la señora' : 'el señor',
      descripcion_inmueble: (raw.descripcion_inmueble || raw.descripcion_local || '').toUpperCase(),
      direccion_inmueble: (raw.direccion_inmueble || '').toUpperCase(),
      monto_alquiler_texto: formatMoney(raw.monto_alquiler || 0),
      monto_mantenimiento_texto: formatMoney(200),
      monto_deposito_texto: formatMoney((parseFloat(String(raw.monto_alquiler || 0).replace(/[^0-9.]/g, '')) * 3)),
      garante_nombre: raw.garante_nombre ? (raw.garante_nombre).toUpperCase() : 'N/A',
      garante_cedula: raw.garante_cedula || 'N/A',
      uso_comercial: raw.uso_comercial || '',
      ...base,
    };
  }

  if (templateKey === 'acto_venta_inmueble') {
    return {
      ...base,
      vendedor_nombre: (raw.vendedor_nombre || '').toUpperCase(),
      vendedor_cedula: raw.vendedor_cedula || '',
      comprador_nombre: (raw.comprador_nombre || '').toUpperCase(),
      comprador_cedula: raw.comprador_cedula || '',
      descripcion_inmueble: (raw.descripcion_inmueble || '').toUpperCase(),
      direccion_inmueble: (raw.direccion_inmueble || '').toUpperCase(),
      titulo_numero: raw.titulo_numero || 'PENDIENTE',
      parcela: raw.parcela || 'PENDIENTE',
      precio_venta_texto: formatMoney(raw.precio_venta || 0),
    };
  }

  if (templateKey === 'acto_venta_vehiculo') {
    return {
      ...base,
      vendedor_nombre: (raw.vendedor_nombre || '').toUpperCase(),
      vendedor_cedula: raw.vendedor_cedula || '',
      comprador_nombre: (raw.comprador_nombre || '').toUpperCase(),
      comprador_cedula: raw.comprador_cedula || '',
      vehiculo_marca: (raw.vehiculo_marca || '').toUpperCase(),
      vehiculo_modelo: (raw.vehiculo_modelo || '').toUpperCase(),
      vehiculo_año: raw.vehiculo_año || '',
      vehiculo_color: (raw.vehiculo_color || '').toUpperCase(),
      vehiculo_placa: (raw.vehiculo_placa || '').toUpperCase(),
      vehiculo_chasis: (raw.vehiculo_chasis || 'N/A').toUpperCase(),
      precio_venta_texto: formatMoney(raw.precio_venta || 0),
      // Optional apoderado paragraph
      has_apoderado: !!raw.apoderado_nombre,
      apoderado_nombre: (raw.apoderado_nombre || '').toUpperCase(),
      apoderado_cedula: raw.apoderado_cedula || '',
    };
  }

  if (templateKey === 'poder_autorizacion') {
    return {
      ...base,
      poderdante_nombre: (raw.poderdante_nombre || '').toUpperCase(),
      poderdante_cedula: raw.poderdante_cedula || '',
      apoderado_nombre: (raw.apoderado_nombre || '').toUpperCase(),
      apoderado_cedula: raw.apoderado_cedula || '',
      proposito_poder: raw.proposito_poder || '',
    };
  }

  return { ...base, ...raw };
}

/**
 * Generate a filled .docx from template + data
 * Returns the output file path
 */
async function generateDocument(templateKey, rawData) {
  const templatePath = path.join(TEMPLATES_DIR, `${templateKey}.docx`);
  
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template not found: ${templateKey}`);
  }

  const data = prepareData(templateKey, rawData);
  const content = fs.readFileSync(templatePath, 'binary');
  const zip = new PizZip(content);

  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
    errorLogging: false,
  });

  try {
    doc.render(data);
  } catch (err) {
    // Fall back to simple text replacement via Python
    console.log('[Generator] docxtemplater failed, using Python fallback:', err.message);
    return await generateWithPython(templateKey, data);
  }

  const buf = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
  const outputPath = path.join(OUTPUT_DIR, `${templateKey}_${Date.now()}.docx`);
  fs.writeFileSync(outputPath, buf);
  
  console.log(`[Generator] ✅ Generated: ${outputPath}`);
  return outputPath;
}

/**
 * Python fallback: text replacement in .docx
 */
async function generateWithPython(templateKey, data) {
  const templatePath = path.join(TEMPLATES_DIR, `${templateKey}_raw.docx`);
  const outputPath = path.join(OUTPUT_DIR, `${templateKey}_${Date.now()}.docx`);

  // Security: write data to temp JSON and pass paths as arguments to avoid shell injection
  const tmpJson = path.join(os.tmpdir(), `guru_doc_${Date.now()}.json`);
  fs.writeFileSync(tmpJson, JSON.stringify(data));

  const script = `
import sys, json, shutil
from docx import Document

src = sys.argv[1]
dst = sys.argv[2]
with open(sys.argv[3], 'r') as f:
    data = json.load(f)

shutil.copy2(src, dst)
doc = Document(dst)

def replace_in_runs(para, data):
    full = ''.join(r.text for r in para.runs)
    new = full
    for k, v in data.items():
        new = new.replace('{' + k + '}', str(v))
    if new != full and para.runs:
        para.runs[0].text = new
        for r in para.runs[1:]: r.text = ''

for p in doc.paragraphs:
    replace_in_runs(p, data)
for t in doc.tables:
    for row in t.rows:
        for cell in row.cells:
            for p in cell.paragraphs:
                replace_in_runs(p, data)

doc.save(dst)
print(dst)
`;

  const result = spawnSync('python3', ['-c', script, templatePath, outputPath, tmpJson], {
    timeout: 30000,
    encoding: 'utf-8',
  });
  fs.unlinkSync(tmpJson);
  if (result.status !== 0) {
    throw new Error(result.stderr || `python3 exited with code ${result.status}`);
  }
  return outputPath;
}

module.exports = { generateDocument, formatMoney, formatDate };
