// Documentos · Etiquetas. Turns the AI's rewrite of a paragraph ("el señor {{NOMBRE_VENDEDOR}}, …")
// into exact character spans of the original paragraph. The literal text around the tags must
// appear in the original, in order, so the AI can never change the legal wording.

const TAG = /\{\{([^}]+)\}\}/g;

function normalizeKey(raw) {
  return String(raw || '')
    .replace(/[{}]/g, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}_ ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

const tagsInText = (text) => [...String(text).matchAll(TAG)].map((m) => normalizeKey(m[1]));

// → [{ key, start, end, value }] (spans of the original), [] when there are no tags, null when it does not align
function alignTagged(original, rewritten) {
  const pieces = String(rewritten).split(TAG); // literal, key, literal, key, …, literal
  if (pieces.length === 1) return pieces[0] === original ? [] : null;
  const literals = pieces.filter((_, i) => i % 2 === 0);
  const keys = pieces.filter((_, i) => i % 2 === 1).map(normalizeKey);

  if (!original.startsWith(literals[0])) return null;
  const last = literals[literals.length - 1];
  if (!original.endsWith(last)) return null;
  const endLimit = original.length - last.length;

  const spans = [];
  let pos = literals[0].length;
  for (let k = 0; k < keys.length; k++) {
    const next = literals[k + 1];
    const isLast = k === keys.length - 1;
    // without text between two tags there is no way to know where one value ends
    if (!isLast && !next) return null;
    const end = isLast ? endLimit : original.indexOf(next, pos + 1);
    if (end < 0 || end <= pos || end > endLimit) return null;
    const value = original.slice(pos, end);
    if (!value.trim() || !keys[k]) return null;
    spans.push({ key: keys[k], start: pos, end, value });
    pos = end + (isLast ? 0 : next.length);
  }
  return spans;
}

// MotherBrain's role codes: a key ending in _VENDEDOR belongs to the VENDEDOR group
const ROLES = ['VENDEDOR', 'COMPRADOR', 'ARRENDADOR', 'ARRENDATARIO', 'DONANTE', 'DONATARIO', 'TESTIGO', 'CONYUGE',
  'APODERADO', 'PODERDANTE', 'GARANTE', 'BENEFICIARIO', 'DEMANDANTE', 'DEMANDADO', 'RECURRENTE', 'RECURRIDO',
  'ACREEDOR', 'DEUDOR', 'SOLICITANTE', 'COMPARECIENTE', 'REPRESENTANTE', 'ABOGADO', 'NOTARIO', 'ALGUACIL',
  'IMPUTADO', 'VICTIMA', 'MAGISTRADO', 'REQUIRENTE'];

function groupOf(key) {
  const role = ROLES.find((r) => key === r || key.endsWith(`_${r}`) || new RegExp(`_${r}( O |\\s*\\d+$)`).test(key));
  return role || 'DOCUMENTO';
}

function labelOf(key, group) {
  const base = group !== 'DOCUMENTO' && key.endsWith(`_${group}`) ? key.slice(0, -(group.length + 1)) : key;
  const text = base.replace(/_/g, ' ').toLowerCase();
  const label = text.charAt(0).toUpperCase() + text.slice(1);
  return group !== 'DOCUMENTO' ? `${label} (${group.toLowerCase()})` : label;
}

const cleanGroup = (g) => normalizeKey(g).replace(/ /g, '_') || null;

function meta(key, given = {}, example = null) {
  const group = cleanGroup(given.group) || groupOf(key);
  return { key, label: String(given.label || '').trim().slice(0, 80) || labelOf(key, group), group, example };
}

// The AI's answer → spans per paragraph, tag list (with the sample value each replaced) and skipped paragraphs
function buildTagging(blocks, answer) {
  const byI = new Map(blocks.map((b) => [b.i, b.text]));
  const given = new Map((answer.tags || []).filter((t) => t && t.key).map((t) => [normalizeKey(t.key), t]));
  const spans = [];
  const skipped = [];
  const tags = new Map();
  for (const p of answer.paragraphs || []) {
    const i = Number(p && p.i);
    if (!byI.has(i) || typeof p.text !== 'string') continue;
    const found = alignTagged(byI.get(i), p.text);
    if (found === null) {
      skipped.push({ i, text: byI.get(i) });
      continue;
    }
    for (const s of found) {
      spans.push({ i, start: s.start, end: s.end, text: `{{${s.key}}}` });
      if (!tags.has(s.key)) tags.set(s.key, meta(s.key, given.get(s.key), s.value));
    }
  }
  return { spans, tags: [...tags.values()], skipped };
}

class EditError extends Error {}

// A selection made in the page ("the paragraph's text + offset + length") → a span of the Word
function selectionSpan(blocks, op) {
  // the page shows tabs, line breaks and non-breaking spaces as one space (same length, so offsets still match)
  const flat = (t) => String(t).replace(/[\t\n\u00a0\u2003]/g, ' ');
  const same = blocks.filter((b) => flat(b.text) === flat(op.text));
  const block = same[Number(op.occurrence) || 0];
  if (!block) throw new EditError('No se encontró ese texto en el documento; recarga e intenta de nuevo');
  const start = Number(op.offset);
  const end = start + Number(op.length);
  if (!(start >= 0 && end > start && end <= block.text.length)) throw new EditError('La selección no es válida');
  for (const m of block.text.matchAll(TAG)) {
    if (start < m.index + m[0].length && end > m.index) throw new EditError('La selección toca una etiqueta existente');
  }
  const value = block.text.slice(start, end);
  if (!value.trim()) throw new EditError('Selecciona el texto a etiquetar');
  return { i: block.i, start, end, value };
}

module.exports = {
  alignTagged, normalizeKey, tagsInText, TAG, ROLES, groupOf, labelOf, meta, buildTagging, selectionSpan, EditError,
};
