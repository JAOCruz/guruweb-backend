#!/usr/bin/env node
// Baja las leyes de scripts/leyes/fuentes.json, las separa en artículos y escribe seeds/leyes/<code>.json.
//   node scripts/leyes/actualizar.js [code ...]
// Necesita pdftotext (poppler: `brew install poppler`). Después de correrlo, se suben los .json al repo y el
// backend los carga solo al arrancar o con Configuración → Ejecutar migraciones (src/legal/library.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { splitArticles } = require('./articulos');

const FUENTES = require('./fuentes.json');
const OUT = path.join(__dirname, '..', '..', 'seeds', 'leyes');

function htmlToText(html) {
  const t = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/h\d>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const i = t.indexOf('LIBRO PRIMERO');
  return i > 0 ? t.slice(i) : t;
}

async function textOf(fuente, dir) {
  const res = await fetch(fuente.source_url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (fuente.format === 'html') return htmlToText(buf.toString('utf8'));
  const pdf = path.join(dir, `${fuente.code}.pdf`);
  fs.writeFileSync(pdf, buf);
  return execFileSync('pdftotext', ['-layout', pdf, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

async function main() {
  const only = process.argv.slice(2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leyes-'));
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of FUENTES.filter((x) => !only.length || only.includes(x.code))) {
    try {
      const articles = splitArticles(await textOf(f, dir));
      if (articles.length < 10) throw new Error(`solo ${articles.length} artículos: revise la fuente`);
      const { format, ...meta } = f;
      const data = { ...meta, fetched_at: new Date().toISOString().slice(0, 10), articles };
      fs.writeFileSync(path.join(OUT, `${f.code}.json`), JSON.stringify(data, null, 1));
      console.log(`✔ ${f.code}: ${articles.length} artículos`);
    } catch (err) {
      console.error(`✖ ${f.code}: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

main();
