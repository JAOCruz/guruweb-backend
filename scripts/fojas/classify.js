// Clasificación inicial por foja: tipo según el nombre y fojas según el modelo (.docx) parecido.
// Uso: node -r dotenv/config scripts/fojas/classify.js [--templates templates/documents] [--out seeds/bot/fojas.json]
// Solo hace SELECT.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fold } = require('../../src/agent/text');
const { FOJA_RATES } = require('../../src/models/fojaRates');

const CAT_REDACTAR = fold('Redactar o digitar un documento');

function classifyTipo(name, categoria) {
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

function fojasFor(name, pagesMap) {
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
  if (!best) return { fojas: 1, fuente: 'por defecto' };
  return { fojas: best.pages, fuente: `modelo: ${best.key}` };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (f, d) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const dir = path.resolve(opt('--templates', 'templates/documents'));
  const out = path.resolve(opt('--out', 'seeds/bot/fojas.json'));
  const pool = require('../../src/db/pool');
  const { rows } = await pool.query(
    `SELECT s.name, c.name AS categoria, s.digitacion_price
       FROM service_catalog s LEFT JOIN service_categories c ON c.id = s.category_id
      WHERE s.active = true ORDER BY c.name, s.name`);
  const pagesMap = templatePages(dir);
  const list = [];
  for (const r of rows) {
    const tipo = classifyTipo(r.name, r.categoria);
    if (!tipo) continue;
    const { fojas, fuente } = fojasFor(r.name, pagesMap);
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
