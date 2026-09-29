const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// Word → PDF with LibreOffice (keeps the legal format). One conversion at a time: LibreOffice
// is heavy, and each run gets its own profile folder so runs never lock each other.
function defaultConverter(input, outDir) {
  return new Promise((resolve, reject) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'lo-profile-'));
    execFile(
      'soffice',
      [`-env:UserInstallation=file://${profile}`, '--headless', '--convert-to', 'pdf', '--outdir', outDir, input],
      { timeout: 90_000 },
      (err) => {
        fs.rm(profile, { recursive: true, force: true }, () => {});
        const out = path.join(outDir, path.basename(input).replace(/\.[^.]+$/, '') + '.pdf');
        if (err || !fs.existsSync(out)) {
          const e = new Error(`PDF conversion failed: ${err ? err.message : 'no output'}`);
          e.code = err && err.code === 'ENOENT' ? 'PDF_UNAVAILABLE' : 'PDF_FAILED';
          return reject(e);
        }
        resolve(out);
      }
    );
  });
}

let converter = defaultConverter;
function setConverter(fn) {
  converter = fn || defaultConverter;
}

let queue = Promise.resolve();
// Converts `input` (a .docx) and moves the result to `target`. Returns `target`.
function convertToPdf(input, target) {
  const run = queue.then(async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-'));
    try {
      const src = path.join(work, 'documento' + path.extname(input));
      fs.copyFileSync(input, src);
      const out = await converter(src, work);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(out, target);
      return target;
    } finally {
      fs.rm(work, { recursive: true, force: true }, () => {});
    }
  });
  queue = run.catch(() => {});
  return run;
}

module.exports = { convertToPdf, setConverter };
