const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const storage = require('../utils/storage');
const { fillTags } = require('./docxText');
const Portfolio = require('./portfolio');

// Exact filling of an approved tagged model, shared by the panel (Etiquetas → Llenar) and the bot
// (preparar_documento): fills the version's Word with `values`, stores the result and creates the
// document (v1) in the client's history. Who decides what goes in `values` (blanks or a refusal) is the caller.
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const tmpDocx = () => path.join(os.tmpdir(), `tags-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.docx`);
const docxName = (title) => `${String(title).replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 100) || 'documento'}.docx`;

async function fillAndStore({ version, values, title, clientId, templateId, userId, notes, invoiceId = null, preparedByBot = false }) {
  const out = tmpDocx();
  await fillTags(version.file_path, out, values);
  const name = docxName(title);
  const stored = storage.saveLocalFile(out, 'portfolio', `${Date.now()}-${crypto.randomBytes(4).toString('hex')}-${name}`);
  fs.rm(out, { force: true }, () => {});
  const id = await Portfolio.createDocument({
    clientId, title, templateId, userId, invoiceId, preparedByBot,
    file: { path: stored, name, mime: DOCX, size: fs.statSync(stored).size, source: 'generated', notes },
  });
  return { id, name };
}

module.exports = { fillAndStore, DOCX };
