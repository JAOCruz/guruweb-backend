#!/usr/bin/env node
// Carga la biblioteca de modelos de Leandro (templates/documents, versión MOTHER BRAIN RPG del 2026-10-27).
//   node scripts/importar-biblioteca.js            → solo muestra lo que haría (no cambia nada)
//   node scripts/importar-biblioteca.js --aplicar  → lo hace
// Corre DENTRO del servidor (railway ssh): las versiones etiquetadas se guardan en el volumen.
// - Cada modelo de la biblioteca actualiza el que ya existe (mismo id: conserva su historial y su enlace
//   con el catálogo) o se crea. Los que ya no están en la biblioteca se desactivan (no se borran).
// - Las etiquetas {{...}} las puso Leandro: se guardan como una versión 'library' y se aprueban tal cual.
// - Queda una corrección pendiente, con aviso a los admins, en los modelos sin etiquetas y en los que
//   perdieron etiquetas que su versión aprobada anterior tenía: Leandro las pone en el panel.
// Repetirlo no duplica nada: un modelo cuya última versión ya es este mismo archivo se salta.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pool = require('../src/db/pool');
const { templatesBaseDir } = require('../src/documentos/templatesCatalog');
const { listTags } = require('../src/documentos/docxText');
const { meta, normalizeKey } = require('../src/documentos/tagging');
const Tags = require('../src/documentos/templateTags');
const Corrections = require('../src/documentos/templateCorrections');
const { activeAdminIds, notifyUsers } = require('../src/agent/tools/notify');

const NOTE = 'Biblioteca de Leandro (2026-10-27)';
const SIN_ETIQUETAS = 'Este modelo llegó sin etiquetas en la biblioteca de Leandro: márquelas (nombres, cédulas, fechas…) para que se pueda llenar.';

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/\.docx?$/, '').replace(/[^a-z0-9/]+/g, ' ').replace(/\s+/g, ' ').trim();
const slugify = (s) => fold(s).replace(/[ /]+/g, '-');

// Los .docx de la biblioteca: ruta relativa, nombre, categorías (carpetas), huella y etiquetas en orden
async function scanLibrary(baseDir) {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.docx$/i.test(e.name) && !e.name.startsWith('~$')) out.push(full);
    }
  };
  walk(baseDir);
  const models = [];
  for (const full of out) {
    const rel = path.relative(baseDir, full).normalize('NFC');
    const keys = [...new Set((await listTags(full)).map(normalizeKey).filter(Boolean))];
    models.push({
      rel, full,
      name: path.basename(rel).replace(/\.docx$/i, '').trim(),
      categories: path.dirname(rel).split(path.sep).filter((c) => c && c !== '.'),
      hash: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex').slice(0, 16),
      keys,
    });
  }
  return models;
}

// Servicios cuyo modelo viejo no está en la biblioteca, ligados a su equivalente (Jay, 2026-10-28)
const RELINK = {
  'Poder Cuota Litis': 'PODER ESPECIAL DE CUOTA LITIS',
  'Poder - Viaje de Menor': 'AUTORIZACIÓN PARA VIAJE DE MENOR',
  'Poder - Guarda y Tutela de Menor': 'PODER DE REPRESENTACION DE GUARDA Y CUSTODIA A MENOR DE EDAD',
  'Poder - Ampliatorio': 'PODER ESPECIAL DE REPRESENTACIÓN - MULTIUSO',
};

// Empareja cada modelo con un doc_templates existente: primero por ruta, luego por nombre. Entre filas con el
// mismo nombre (duplicados) gana la que está ligada a un servicio, luego la aprobada, luego la más vieja.
function matchExisting(models, rows, linked = new Set()) {
  const byPath = new Map(); const byName = new Map();
  for (const r of rows) {
    byPath.set(fold(r.file_path), r);
    const k = fold(r.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(r);
  }
  const rank = (r) => (linked.has(r.id) ? 0 : 2) + (r.approved_tag_version_id ? 0 : 1);
  for (const list of byName.values()) list.sort((a, b) => rank(a) - rank(b) || a.id - b.id);
  const taken = new Set();
  const pick = (r) => (r && !taken.has(r.id) ? (taken.add(r.id), r) : null);
  const matched = models.map((m) => {
    const r = pick(byPath.get(fold(m.rel))) || pick((byName.get(fold(m.name)) || []).find((x) => !taken.has(x.id)));
    return { model: m, existing: r };
  });
  const deactivate = rows.filter((r) => !taken.has(r.id) && r.is_active);
  return { matched, deactivate };
}

async function ensureCategory(client, name, parentId) {
  const slug = slugify(name);
  const { rows } = await client.query(
    `SELECT id FROM doc_categories WHERE slug = $1 AND parent_id ${parentId ? '= $2' : 'IS NULL'} LIMIT 1`,
    parentId ? [slug, parentId] : [slug]);
  if (rows.length) return rows[0].id;
  const { rows: ins } = await client.query(
    'INSERT INTO doc_categories (name, slug, parent_id, sort_order) VALUES ($1, $2, $3, 0) RETURNING id', [name, slug, parentId]);
  return ins[0].id;
}

async function leandroId() {
  const { rows } = await pool.query(
    `SELECT id FROM users WHERE role = 'admin' AND is_active IS NOT FALSE AND (username ILIKE '%leandro%' OR name ILIKE '%leandro%')
     ORDER BY id LIMIT 1`);
  return rows[0]?.id || null;
}

async function versionTags(versionId) {
  if (!versionId) return [];
  const v = await Tags.getVersion(versionId);
  return v ? (v.tags || []).map((t) => t.key) : [];
}

// Corrección pendiente + aviso a los admins, salvo que ya haya una pendiente con el mismo texto
async function flagForReview(templateId, name, comment, admins) {
  const { rows } = await pool.query(
    `SELECT 1 FROM template_corrections WHERE template_id = $1 AND status = 'pending' AND comment = $2`, [templateId, comment]);
  if (rows.length) return false;
  const correction = await Corrections.create({ templateId, versionId: await Tags.latestVersionId(templateId), comment, userId: null });
  await notifyUsers(admins, {
    type: 'approval', title: '🏷️ Modelo para revisar',
    message: `«${name}»: ${comment.slice(0, 200)}`,
    link: `/documents?tab=etiquetas&model=${templateId}`,
    metadata: { template_id: templateId, correction_id: correction.id, biblioteca: true },
  });
  return true;
}

async function importLibrary({ baseDir = templatesBaseDir(), apply = false, log = console.log } = {}) {
  const models = await scanLibrary(baseDir);
  // los de la papelera también se emparejan, para no crearlos de nuevo: se quedan en la papelera
  const { rows } = await pool.query('SELECT id, name, file_path, is_active, approved_tag_version_id, deleted_at FROM doc_templates');
  const { rows: links } = await pool.query(`SELECT id, name, template_id FROM service_catalog WHERE active AND template_id ~ '^[0-9]+$'`);
  const linked = new Set(links.map((l) => Number(l.template_id)));
  const all = matchExisting(models, rows, linked);
  const enPapelera = all.matched.filter((x) => x.existing && x.existing.deleted_at);
  const matched = all.matched.filter((x) => !(x.existing && x.existing.deleted_at));
  const deactivate = all.deactivate.filter((r) => !r.deleted_at);
  const summary = {
    modelos: models.length,
    actualizados: matched.filter((x) => x.existing).length,
    nuevos: matched.filter((x) => !x.existing).length,
    desactivados: deactivate.length,
    con_etiquetas: models.filter((m) => m.keys.length).length,
    sin_etiquetas: models.filter((m) => !m.keys.length).map((m) => m.rel),
    versiones: 0, saltados: 0, para_revisar: [],
    en_papelera: enPapelera.map((x) => x.existing.name),
  };
  // servicios ligados a un modelo que se desactiva: al de la biblioteca con el mismo nombre o al equivalente de RELINK
  const goneById = new Map(deactivate.map((r) => [r.id, r]));
  const libByName = new Map(matched.map((x) => [fold(x.model.name), x]));
  const relink = [];
  for (const l of links) {
    const old = goneById.get(Number(l.template_id));
    if (!old) continue;
    const target = libByName.get(fold(old.name)) || (RELINK[l.name] && libByName.get(fold(RELINK[l.name])));
    relink.push({ servicio: l, target });
  }
  summary.servicios_religados = relink.filter((x) => x.target).map((x) => `${x.servicio.name} → ${x.target.model.name}`);
  summary.servicios_sin_modelo = relink.filter((x) => !x.target).map((x) => x.servicio.name);

  if (!apply) {
    log(`[biblioteca] modo prueba (sin --aplicar no se cambia nada). Carpeta: ${baseDir}`);
    log(`[biblioteca] ${JSON.stringify({ ...summary, sin_etiquetas: summary.sin_etiquetas.length, servicios_sin_modelo: summary.servicios_sin_modelo.length, servicios_religados: summary.servicios_religados.length, en_papelera: summary.en_papelera.length })}`);
    for (const r of summary.en_papelera) log(`  sigue en la papelera: ${r}`);
    for (const r of summary.sin_etiquetas) log(`  sin etiquetas: ${r}`);
    for (const r of deactivate.slice(0, 300)) log(`  se desactiva: ${r.name}`);
    for (const s of summary.servicios_religados) log(`  servicio que se liga al modelo nuevo: ${s}`);
    for (const s of summary.servicios_sin_modelo) log(`  servicio que se queda sin modelo: ${s}`);
    return summary;
  }

  const approver = await leandroId();
  const admins = await activeAdminIds();
  const idOf = new Map();
  for (const { model, existing } of matched) {
    const client = await pool.connect();
    let id;
    try {
      await client.query('BEGIN');
      let parentId = null;
      for (const c of model.categories) parentId = await ensureCategory(client, c, parentId);
      const values = [model.name, slugify(model.name), parentId, model.rel, path.basename(model.rel)];
      if (existing) {
        id = existing.id;
        await client.query(
          `UPDATE doc_templates SET name = $1, slug = $2, category_id = $3, file_path = $4, file_name = $5, doc_type = 'docx',
                  is_active = TRUE, updated_at = NOW() WHERE id = $6`, [...values, id]);
      } else {
        const { rows: ins } = await client.query(
          `INSERT INTO doc_templates (name, slug, category_id, file_path, file_name, doc_type, description, is_active, sort_order)
           VALUES ($1, $2, $3, $4, $5, 'docx', $6, TRUE, 0) RETURNING id`, [...values, `Plantilla: ${model.name}`]);
        id = ins[0].id;
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    idOf.set(model, id);

    if (!model.keys.length) {
      if (await flagForReview(id, model.name, SIN_ETIQUETAS, admins)) summary.para_revisar.push(model.name);
      continue;
    }
    const latest = await Tags.latestVersionId(id);
    const latestV = latest ? await Tags.getVersion(latest) : null;
    if (latestV && latestV.source === 'library' && String(latestV.notes || '').includes(model.hash)) { summary.saltados++; continue; }
    const before = await versionTags(existing?.approved_tag_version_id);
    // createVersion borra el archivo que recibe si está en la carpeta temporal: se le pasa una copia
    const copy = path.join(os.tmpdir(), `biblioteca-${id}-${crypto.randomBytes(4).toString('hex')}.docx`);
    fs.copyFileSync(model.full, copy);
    const v = await Tags.createVersion({
      templateId: id, localFile: copy, tags: model.keys.map((k) => meta(k)), source: 'library',
      notes: `${NOTE} · ${model.hash}`, userId: approver,
    });
    await Tags.approve(v.id, approver);
    summary.versiones++;
    const perdidas = before.filter((k) => !model.keys.includes(k));
    if (perdidas.length) {
      const comment = `La versión de la biblioteca de Leandro no trae estas etiquetas que tenía la versión aprobada anterior: ${perdidas.join(', ')}. Revise si hacen falta y agréguelas.`;
      if (await flagForReview(id, model.name, comment, admins)) summary.para_revisar.push(model.name);
    }
  }
  for (const { servicio, target } of relink) {
    if (target) await pool.query('UPDATE service_catalog SET template_id = $1 WHERE id = $2', [String(idOf.get(target.model)), servicio.id]);
  }
  if (deactivate.length) {
    await pool.query('UPDATE doc_templates SET is_active = FALSE, updated_at = NOW() WHERE id = ANY($1::int[])', [deactivate.map((r) => r.id)]);
  }
  log(`[biblioteca] listo: ${JSON.stringify({ ...summary, sin_etiquetas: summary.sin_etiquetas.length, en_papelera: summary.en_papelera.length })}`);
  return summary;
}

if (require.main === module) {
  importLibrary({ apply: process.argv.includes('--aplicar') })
    .then(async () => { await pool.end(); })
    .catch(async (err) => {
      console.error('[biblioteca] error:', String(err.message).replace(/postgres(ql)?:\/\/[^\s]*/gi, '[url]'));
      try { await pool.end(); } catch {}
      process.exit(1);
    });
}

module.exports = { importLibrary, scanLibrary, matchExisting, fold };
