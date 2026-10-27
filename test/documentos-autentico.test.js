// Formato auténtico (Leandro, 2026-10-27): "dejarlo igual pero darle un formato tipo auténtico sin espacios".
// Sin párrafos vacíos ni espacio entre párrafos, texto justificado y el final de cada párrafo relleno
// con rayas hasta el margen. Lo hace el motor de Word, no la IA.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { listBlocks, formatAutentico } = require('../src/documentos/docxText');

const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-autentico-'));

function make(file) {
  spawnSync(PY, ['-c', `import sys
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt
d = Document()
t = d.add_paragraph("PODER DE AUTORIZACION"); t.alignment = WD_ALIGN_PARAGRAPH.CENTER
d.add_paragraph("")
p = d.add_paragraph("Yo, JUAN PEREZ, autorizo a MARIA GOMEZ ante la Aduana."); p.paragraph_format.space_after = Pt(12)
d.add_paragraph("   ")
d.add_paragraph("PRIMERO: Para retirar mercancías.")
tb = d.add_table(rows=1, cols=1); tb.cell(0, 0).paragraphs[0].text = ""
d.add_paragraph("Hecho en Santo Domingo.")
d.add_paragraph("")
d.add_paragraph("")
d.add_paragraph("JUAN PEREZ\t\tMARIA GOMEZ")
d.add_paragraph("Poderdante\t\tApoderada")
d.add_paragraph("")
d.save(sys.argv[1])`, file]);
}

function inspect(file) {
  const r = spawnSync(PY, ['-c', `import sys, json
from docx import Document
from docx.oxml.ns import qn
d = Document(sys.argv[1])
out = []
for p in d.paragraphs:
    pf = p.paragraph_format
    stops = [(int(s.position), str(s.alignment), str(s.leader)) for s in pf.tab_stops]
    last = p.runs[-1]._r if p.runs else None
    ends_tab = last is not None and last.find(qn("w:tab")) is not None and not p.runs[-1].text.strip()
    out.append({"text": p.text, "align": str(p.alignment), "stops": stops, "ends_tab": ends_tab,
                "after": None if pf.space_after is None else int(pf.space_after)})
s = d.sections[-1]
print(json.dumps({"ps": out, "width": int(s.page_width - s.left_margin - s.right_margin), "cells": len(d.tables[0].cell(0,0).paragraphs)}))`, file]);
  return JSON.parse(r.stdout.toString());
}

test('formato auténtico: sin párrafos vacíos, justificado y con rayas hasta el margen', { skip: !hasDocx }, async () => {
  const src = path.join(dir, 'poder.docx');
  const out = path.join(dir, 'poder-autentico.docx');
  make(src);
  const res = await formatAutentico(src, out);
  assert.deepEqual(res, { removed: 3, filled: 3 });
  const { ps, width, cells } = inspect(out);
  assert.deepEqual(ps.map((p) => p.text.trim()), ['PODER DE AUTORIZACION', 'Yo, JUAN PEREZ, autorizo a MARIA GOMEZ ante la Aduana.',
    'PRIMERO: Para retirar mercancías.', 'Hecho en Santo Domingo.', '', '', 'JUAN PEREZ\t\tMARIA GOMEZ', 'Poderdante\t\tApoderada']);
  // el título centrado se queda como está
  assert.match(ps[0].align, /CENTER/);
  assert.equal(ps[0].ends_tab, false);
  for (const p of ps.slice(1, 4)) {
    assert.match(p.align, /JUSTIFY/);
    assert.equal(p.ends_tab, true);
    assert.deepEqual(p.stops, [[width, 'RIGHT (2)', 'DASHES (2)']]);
    assert.equal(p.after, 0);
  }
  // el espacio para firmar y las líneas de firma se quedan como estaban
  for (const p of ps.slice(4)) {
    assert.equal(p.ends_tab, false);
    assert.deepEqual(p.stops, []);
    assert.equal(p.align, 'None');
  }
  assert.equal(cells, 1, 'las tablas no se tocan');
  assert.equal((await listBlocks(out)).length, 9); // 8 del cuerpo + la celda
});

test('aplicarlo dos veces no agrega más rayas', { skip: !hasDocx }, async () => {
  const once = path.join(dir, 'poder-autentico.docx');
  const twice = path.join(dir, 'poder-autentico-2.docx');
  assert.deepEqual(await formatAutentico(once, twice), { removed: 0, filled: 0 });
  assert.deepEqual(inspect(twice), inspect(once));
});

// Cambios de formato que la IA elige de una lista fija y aplica el motor de Word (Leandro, 2026-10-27)
const { applyFormat } = require('../src/documentos/docxText');

function makeSimple(file) {
  spawnSync(PY, ['-c', `import sys
from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
d = Document()
t = d.add_paragraph("PODER"); t.alignment = WD_ALIGN_PARAGRAPH.CENTER
d.add_paragraph("Yo, JUAN PEREZ, autorizo.")
d.add_paragraph("JUAN PEREZ\\t\\tMARIA GOMEZ")
d.save(sys.argv[1])`, file]);
}

function look(file) {
  const r = spawnSync(PY, ['-c', `import sys, json
from docx import Document
d = Document(sys.argv[1])
out = []
for p in d.paragraphs:
    pf = p.paragraph_format
    out.append({"align": str(p.alignment), "fonts": sorted({r.font.name or "" for r in p.runs}), "sizes": sorted({r.font.size.pt if r.font.size else 0 for r in p.runs}),
                "bold": [bool(r.bold) for r in p.runs], "line": pf.line_spacing, "after": None if pf.space_after is None else pf.space_after.pt})
s = d.sections[0]
print(json.dumps({"ps": out, "margins": [round(s.top_margin.cm, 2), round(s.bottom_margin.cm, 2), round(s.left_margin.cm, 2), round(s.right_margin.cm, 2)]}))`, file]);
  return JSON.parse(r.stdout.toString());
}

test('formato: letra, tamaño, negrita, alineación, interlineado y márgenes', { skip: !hasDocx }, async () => {
  const src = path.join(dir, 'fmt.docx');
  const out = path.join(dir, 'fmt-out.docx');
  makeSimple(src);
  await applyFormat(src, out, [
    { op: 'font', name: 'Times New Roman', size: 12 },
    { op: 'bold', i: 0, value: true },
    { op: 'align', value: 'justify' },
    { op: 'spacing', line: 1.5, after: 0 },
    { op: 'margins', top: 2.5, bottom: 2.5, left: 3, right: 2 },
  ]);
  const { ps, margins } = look(out);
  for (const p of ps) {
    assert.deepEqual(p.fonts, ['Times New Roman']);
    assert.deepEqual(p.sizes, [12]);
    assert.equal(p.line, 1.5);
    assert.equal(p.after, 0);
  }
  assert.deepEqual(ps[0].bold, [true]);
  assert.deepEqual(ps[1].bold, [false]);
  // "todo" justificado: el título centrado y las firmas se quedan como estaban
  assert.match(ps[0].align, /CENTER/);
  assert.match(ps[1].align, /JUSTIFY/);
  assert.equal(ps[2].align, 'None');
  assert.deepEqual(margins, [2.5, 2.5, 3, 2]);
});

test('formato: un párrafo en particular y valores fuera de rango se ignoran', { skip: !hasDocx }, async () => {
  const src = path.join(dir, 'fmt.docx');
  const out = path.join(dir, 'fmt-out-2.docx');
  await applyFormat(src, out, [
    { op: 'align', i: 0, value: 'left' },
    { op: 'font', i: 1, size: 14 },
    { op: 'font', size: 300 },
    { op: 'margins', top: -4 },
    { op: 'inventado', i: 0 },
  ]);
  const { ps, margins } = look(out);
  assert.match(ps[0].align, /LEFT/);
  assert.deepEqual(ps[1].sizes, [14]);
  assert.deepEqual(ps[2].sizes, [0]);
  assert.deepEqual(margins, look(src).margins);
});
