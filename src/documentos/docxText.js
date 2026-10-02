const path = require('path');
const { spawn } = require('child_process');

// Node side of docx_text.py (Word engine for Documentos)
const SCRIPT = path.join(__dirname, 'docx_text.py');

function run(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON_BIN || 'python3', [SCRIPT, ...args], { timeout: 60_000 });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err.trim() || `docx_text exited ${code}`))));
    if (input !== undefined) child.stdin.end(JSON.stringify(input));
    else child.stdin.end();
  });
}

const listBlocks = async (file) => JSON.parse(await run(['list', file]));
const hasTags = async (file) => (await run(['hastags', file])) === '1';
const applyOps = (file, out, ops) => run(['apply', file, out], ops);
const fillTags = (file, out, values) => run(['fill', file, out], values);
const applySpans = (file, out, spans) => run(['spans', file, out], spans);
const listTags = async (file) => JSON.parse(await run(['tags', file]));

module.exports = { listBlocks, hasTags, applyOps, fillTags, applySpans, listTags };
