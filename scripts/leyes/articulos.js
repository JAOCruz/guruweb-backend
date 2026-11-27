// Separa el texto de una ley (sacado de su PDF o HTML) en artículos, con la sección (Libro/Título/Capítulo) donde
// está cada uno. Se usa al bajar las leyes (scripts/leyes/actualizar.js) y en las pruebas.

const HEADER = /^\s*(?:Art[ií]culo|ART[IÍ]CULO|Art\.)\s*(\d{1,4})(\s*(?:bis|ter|quater))?\s*(?:\.\s*-|\.-|\.|-|–|:)\s*/i;
const SECTION = /^\s*(LIBRO|T[IÍ]TULO|CAP[IÍ]TULO|SECCI[OÓ]N)\b/i;
const PAGE_NOISE = /^\s*(?:-?\s*\d{1,4}\s*-?|P[aá]gina\s+\d+(?:\s+de\s+\d+)?)\s*$/i;
const MAX_TEXT = 6000;

const squash = (lines) =>
  lines
    .join('\n')
    .replace(/(\p{L})-\n\s*(\p{L})/gu, '$1$2') // palabra cortada al final de la línea
    .replace(/\s+/g, ' ')
    .trim();

// Devuelve [{ num, ord, section, text }] en orden. Un número que retrocede o salta demasiado es una referencia a
// otro artículo que quedó al inicio de una línea (o una copia repetida del texto): se toma como parte del anterior.
function splitArticles(raw) {
  const lines = String(raw || '').replace(/\f/g, '\n').split(/\r?\n/);
  const out = [];
  let current = null;
  let section = null;
  let pendingSection = null;
  let last = 0;
  let started = false;

  for (const line of lines) {
    if (PAGE_NOISE.test(line)) continue;
    const m = line.match(HEADER);
    if (m) {
      const n = Number(m[1]);
      const suffix = (m[2] || '').trim().toLowerCase();
      const ok = started ? (suffix ? n === last : n > last && n <= last + 25) : n === 1;
      if (ok) {
        if (current) out.push(current);
        started = true;
        last = n;
        if (pendingSection) { section = pendingSection; pendingSection = null; }
        current = { num: suffix ? `${n} ${suffix}` : String(n), ord: out.length + 1, section, lines: [line.replace(HEADER, '')] };
        continue;
      }
    }
    if (SECTION.test(line) && line.trim().length < 140) {
      pendingSection = line.trim().replace(/\s+/g, ' ');
      continue;
    }
    if (pendingSection && line.trim() && line.trim().length < 140 && !current?.lines.at(-1)?.trim()) {
      // el nombre del título/capítulo suele ir en la línea siguiente
      if (!/[.;]$/.test(line.trim())) { pendingSection += ` ${line.trim()}`; continue; }
    }
    if (current) current.lines.push(line);
  }
  if (current) out.push(current);

  return out
    .map(({ lines: l, ...a }) => ({ ...a, text: squash(l).slice(0, MAX_TEXT) }))
    .filter((a) => a.text.length > 0);
}

// Para buscar sin importar acentos ni mayúsculas
function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

module.exports = { splitArticles, fold };
