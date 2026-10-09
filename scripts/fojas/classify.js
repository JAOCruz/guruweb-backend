// Clasificación inicial por foja: tipo según el nombre y fojas según el modelo (.docx) parecido.
// Uso: node -r dotenv/config scripts/fojas/classify.js [--templates templates/documents] [--out seeds/bot/fojas.json]
// Solo hace SELECT.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fold } = require('../../src/agent/text');
const { FOJA_RATES } = require('../../src/models/fojaRates');

const CAT_REDACTAR = fold('Redactar o digitar un documento');

// service: { precio_rango, unit_type } de la fila. Los servicios con precio_rango o "por trabajo"
// (Antiplagio, monográficos, asignaciones escolares) se cotizan por rango, no por foja.
function classifyTipo(name, categoria, service = {}) {
  if ((service && service.precio_rango != null) || fold((service && service.unit_type) || '') === 'por trabajo') return null;
  const n = fold(name);
  if (fold(categoria) !== CAT_REDACTAR && !n.startsWith('instancia')) return null;
  if (/coletilla|original adicional o duplicado/.test(n)) return null;
  if (/autentic|determinacion|particion/.test(n)) return 'legal_motivada';
  if (/demanda|escrito|recurso|conclusion|defensa|amparo|nomina/.test(n)) return 'carta_motivada';
  if (/^instancia|carta|notificacion|comunicacion/.test(n)) return 'carta_simple';
  return 'legal_simple';
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.docx$/i.test(e.name) && !e.name.startsWith('~$')) out.push(p);
  }
  return out;
}

// Map<nombre base plegado, páginas>. Plantillas sin <Pages> legible se saltan.
function templatePages(dir) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  for (const file of walk(dir)) {
    let xml;
    try {
      xml = execFileSync('unzip', ['-p', file, 'docProps/app.xml'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
    } catch { continue; }
    const m = xml.match(/<Pages>\s*(\d+)\s*<\/Pages>/);
    const pages = m ? parseInt(m[1], 10) : 0;
    if (pages < 1) continue;
    const key = fold(path.basename(file).replace(/\.docx$/i, ''));
    if (!map.has(key)) map.set(key, pages);
  }
  return map;
}

const tokens = (s) => new Set(fold(s).split(/[^a-z0-9ñ]+/).filter((t) => t.length >= 3));

// Sin modelo: las fojas se estiman del precio anterior (precio / tarifa, mínimo 1) para que el precio
// no cambie de golpe hasta que Leandro revise; sin precio anterior, 1. En variantes (Avanzado)/(Extensivo)
// con modelo, el mayor entre las páginas del modelo y ese estimado.
function fojasFor(name, pagesMap, { precioAnterior = null, tarifa = null } = {}) {
  const n = fold(name);
  const nt = tokens(n);
  let best = null;
  for (const [key, pages] of pagesMap) {
    let score;
    if (key === n) score = Infinity;
    else if (key.includes(n) || n.includes(key)) {
      const shared = [...tokens(key)].filter((t) => nt.has(t)).length;
      if (shared < 2) continue;
      score = shared;
    } else continue;
    if (!best || score > best.score) best = { score, key, pages };
  }
  const p = Number(precioAnterior);
  const estimado = precioAnterior != null && p > 0 && Number(tarifa) > 0 ? Math.max(1, Math.round(p / Number(tarifa))) : null;
  if (!best) {
    if (estimado !== null) return { fojas: estimado, fuente: 'estimado del precio anterior' };
    return { fojas: 1, fuente: 'por defecto' };
  }
  // El modelo es la versión básica: en "(Avanzado)"/"(Extensivo)" (más fojas) gana el mayor entre modelo y estimado.
  if (/\((avanzado|extensivo)\)/.test(n) && estimado !== null && estimado > best.pages) {
    return { fojas: estimado, fuente: `modelo: ${best.key} (ajustado al precio anterior)` };
  }
  return { fojas: best.pages, fuente: `modelo: ${best.key}` };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const dir = path.resolve(opt('--templates', 'templates/documents'));
  const out = path.resolve(opt('--out', 'seeds/bot/fojas.json'));
  const pool = require('../../src/db/pool');
  const { rows } = await pool.query(
    `SELECT s.name, c.name AS categoria, s.digitacion_price, s.precio_rango, s.unit_type
       FROM service_catalog s LEFT JOIN service_categories c ON c.id = s.category_id
      WHERE s.active = true ORDER BY c.name, s.name`);
  const pagesMap = templatePages(dir);
  const list = [];
  for (const r of rows) {
    const tipo = classifyTipo(r.name, r.categoria, r);
    if (!tipo) continue;
    const { fojas, fuente } = fojasFor(r.name, pagesMap, { precioAnterior: r.digitacion_price, tarifa: FOJA_RATES[tipo] });
    list.push({
      nombre: r.name, categoria: r.categoria, foja_tipo: tipo, fojas, fuente,
      precio_anterior: r.digitacion_price == null ? null : Number(r.digitacion_price),
      precio_nuevo: FOJA_RATES[tipo] * fojas,
    });
  }
  fs.writeFileSync(out, JSON.stringify(list, null, 2) + '\n');
  console.log(`Clasificados: ${list.length} de ${rows.length} · modelos leídos: ${pagesMap.size} → ${out}`);
  await pool.end();
}

module.exports = { classifyTipo, templatePages, fojasFor };

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
