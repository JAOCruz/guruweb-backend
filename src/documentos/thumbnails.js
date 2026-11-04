const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const storage = require('../utils/storage');
const { convertToPdf } = require('./pdf');

// Library cards: a PNG of a model's first page, kept on the volume. Named after the file's content, not its date:
// the library's files get a new date on every deploy, and regenerating them all would keep LibreOffice busy.
const SUBDIR = 'template_thumbs';
const WIDTH = 480;

const thumbnailsDir = () => path.dirname(storage.getFilePath(SUBDIR, 'x'));

function defaultRenderer(pdfFile, target) {
  return new Promise((resolve, reject) => {
    const prefix = target.replace(/\.png$/, '');
    execFile('pdftoppm', ['-f', '1', '-l', '1', '-singlefile', '-png', '-scale-to-x', String(WIDTH), '-scale-to-y', '-1', pdfFile, prefix], { timeout: 30_000 }, (err) => {
      if (err) return reject(Object.assign(new Error(`Thumbnail failed: ${err.message}`), { code: err.code === 'ENOENT' ? 'PDF_UNAVAILABLE' : 'THUMB_FAILED' }));
      resolve();
    });
  });
}

let renderer = defaultRenderer;
const setRenderer = (fn) => { renderer = fn || defaultRenderer; };

const contentHash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);

// Remembered until the next restart, so a Word that cannot be converted doesn't hold LibreOffice on every visit
const failed = new Set();

// One at a time, so a page full of cards never makes someone asking for a real PDF wait behind all of them
let queue = Promise.resolve();

// Path of the thumbnail of `file`, generating it the first time. A model's older thumbnails are removed.
async function modelThumbnail(modelId, file) {
  const hash = contentHash(file);
  const name = `${modelId}-${hash}.png`;
  const target = storage.getFilePath(SUBDIR, name);
  if (fs.existsSync(target)) return target;
  if (failed.has(name)) throw Object.assign(new Error('Thumbnail failed before'), { code: 'THUMB_FAILED' });
  const run = queue.then(async () => {
    if (fs.existsSync(target)) return target; // asked twice while waiting
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-'));
    try {
      const isPdf = path.extname(file).toLowerCase() === '.pdf';
      const pdfFile = isPdf ? file : await convertToPdf(file, path.join(work, 'modelo.pdf'));
      const tmp = path.join(work, 'miniatura.png');
      await renderer(pdfFile, tmp);
      removeThumbnails(modelId);
      fs.copyFileSync(tmp, target);
      return target;
    } catch (err) {
      failed.add(name);
      throw err;
    } finally {
      fs.rm(work, { recursive: true, force: true }, () => {});
    }
  });
  queue = run.catch(() => {});
  return run;
}

// Forgets every thumbnail of a model (its file changed, or held data that must be gone)
function removeThumbnails(modelId) {
  const dir = thumbnailsDir();
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`${modelId}-`)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

module.exports = { modelThumbnail, removeThumbnails, setRenderer, thumbnailsDir };
