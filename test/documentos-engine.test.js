const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { listBlocks, applySpans, fillTags, listTags } = require('../src/documentos/docxText');

const PY = process.env.PYTHON_BIN || 'python3';
const hasDocx = spawnSync(PY, ['-c', 'import docx']).status === 0;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guru-engine-'));

// One paragraph split into runs: "el señor " + bold "JUAN " + bold "PEREZ" + ", vende."
function makeRuns(file) {
  spawnSync(PY, ['-c', `import sys
from docx import Document
d = Document()
p = d.add_paragraph()
p.add_run("el señor ")
r = p.add_run("JUAN "); r.bold = True
r = p.add_run("PEREZ"); r.bold = True
p.add_run(", vende.")
d.add_paragraph("PRIMERO: precio RD$100.")
d.save(sys.argv[1])`, file]);
}

function runs(file) {
  const r = spawnSync(PY, ['-c', `import sys, json
from docx import Document
d = Document(sys.argv[1])
print(json.dumps([[r.text, bool(r.bold)] for r in d.paragraphs[0].runs]))`, file]);
  return JSON.parse(r.stdout.toString());
}

test('a span across two bold runs becomes one bold run with the tag; the rest keeps its runs', { skip: !hasDocx }, async () => {
  const src = path.join(dir, 'a.docx');
  const out = path.join(dir, 'a-tagged.docx');
  makeRuns(src);
  await applySpans(src, out, [{ i: 0, start: 9, end: 19, text: '{{NOMBRE_VENDEDOR}}' }, { i: 1, start: 16, end: 22, text: '{{PRECIO}}' }]);
  assert.deepEqual(runs(out), [['el señor ', false], ['{{NOMBRE_VENDEDOR}}', true], ['', true], [', vende.', false]]);
  assert.deepEqual((await listBlocks(out)).map((b) => b.text), ['el señor {{NOMBRE_VENDEDOR}}, vende.', 'PRIMERO: precio {{PRECIO}}.']);
  assert.deepEqual(await listTags(out), ['NOMBRE_VENDEDOR', 'PRECIO']);
});

test('fill keeps the formatting of each tag and leaves tags without a value as they are', { skip: !hasDocx }, async () => {
  const tagged = path.join(dir, 'a-tagged.docx');
  const out = path.join(dir, 'a-filled.docx');
  await fillTags(tagged, out, { NOMBRE_VENDEDOR: 'MARÍA GÓMEZ' });
  assert.deepEqual(runs(out), [['el señor ', false], ['MARÍA GÓMEZ', true], ['', true], [', vende.', false]]);
  assert.deepEqual((await listBlocks(out)).map((b) => b.text), ['el señor MARÍA GÓMEZ, vende.', 'PRIMERO: precio {{PRECIO}}.']);
});

test('overlapping or out-of-range spans are ignored instead of corrupting the paragraph', { skip: !hasDocx }, async () => {
  const src = path.join(dir, 'a.docx');
  const out = path.join(dir, 'a-bad.docx');
  await applySpans(src, out, [{ i: 0, start: 9, end: 14, text: '{{A}}' }, { i: 0, start: 12, end: 19, text: '{{B}}' }, { i: 0, start: 5, end: 500, text: '{{C}}' }, { i: 9, start: 0, end: 1, text: '{{D}}' }]);
  assert.equal((await listBlocks(out))[0].text, 'el señor {{A}}PEREZ, vende.');
});
