#!/usr/bin/env node
// Los 20 modelos iniciales del bot (seeds/bot/modelos-iniciales.json):
//   1. resuelve cada nombre a un doc_templates ACTIVO (nombre exacto, sin espacios sobrantes);
//      si falta alguno, o un servicio no existe, aborta ANTES de escribir nada;
//   2. liga service_catalog.template_id = id del modelo (texto) para las entradas con servicio, en una transacción;
//   3. etiqueta con IA solo los modelos que siguen sin etiquetas y tienen su Word, con el mismo código
//      del lote de Documentos → Etiquetas (tagModels). No aprueba nada: eso lo hace un admin en Etiquetas.
// Nunca imprime secretos: solo nombres de modelos y servicios, ids y conteos.
//
//   railway run node -r dotenv/config scripts/tag-initial-models.js --dry-run
//   railway run node -r dotenv/config scripts/tag-initial-models.js [--user=<username>]
//
// --dry-run: hace todo de solo lectura e imprime lo que haría (funciona sin el volumen).
// Sin --dry-run exige que exista el volumen de Railway (RAILWAY_VOLUME_MOUNT_PATH): las versiones etiquetadas se
// guardan ahí, así que el etiquetado real se corre dentro del contenedor (railway ssh), no con `railway run`.
// --user: usuario que figura como autor de las versiones (por defecto ninguno: "—" en Etiquetas).
const fs = require('fs');
const path = require('path');
const pool = require('../src/db/pool');
const Tags = require('../src/documentos/templateTags');
const { getStorageRoot } = require('../src/utils/storage');
const { tagModel, tagModels, originalFile } = require('../src/routes/documentosTags');

const DEFAULT_FILE = path.join(__dirname, '..', 'seeds', 'bot', 'modelos-iniciales.json');

function readEntries(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data) || !data.length) throw new Error(`${path.basename(file)} debe ser un arreglo con entradas`);
  for (const e of data) {
    if (!e || typeof e.modelo !== 'string' || !e.modelo.trim()) throw new Error('Cada entrada necesita "modelo"');
    if (e.servicio !== null && (typeof e.servicio !== 'string' || !e.servicio.trim())) throw new Error(`"servicio" de «${e.modelo}» debe ser un nombre o null`);
  }
  return data.map((e) => ({ modelo: e.modelo.trim(), servicio: e.servicio && e.servicio.trim() }));
}

// Exact name among the ACTIVE models (whitespace around the name ignored; production has one with a trailing space)
async function resolveModels(entries) {
  const missing = [];
  const models = [];
  for (const e of entries) {
    const { rows } = await pool.query(
      'SELECT id, name, file_path FROM doc_templates WHERE is_active = TRUE AND btrim(name) = $1 ORDER BY id', [e.modelo]
    );
    if (rows.length !== 1) missing.push(rows.length ? `${e.modelo} (${rows.length} modelos activos con ese nombre)` : e.modelo);
    else models.push({ ...rows[0], servicio: e.servicio });
  }
  if (missing.length) throw new Error(`Modelos que no existen (activos) en doc_templates:\n  - ${missing.join('\n  - ')}`);
  return models;
}

async function resolveServices(models) {
  const missing = [];
  const links = [];
  for (const m of models) {
    if (!m.servicio) continue;
    const { rows } = await pool.query('SELECT id, name, template_id FROM service_catalog WHERE active = TRUE AND name = $1 ORDER BY id', [m.servicio]);
    if (rows.length !== 1) missing.push(rows.length ? `${m.servicio} (${rows.length} servicios activos con ese nombre)` : m.servicio);
    else links.push({ serviceId: rows[0].id, service: rows[0].name, previous: rows[0].template_id, templateId: m.id, model: m.name });
  }
  if (missing.length) throw new Error(`Servicios que no existen (activos) en service_catalog:\n  - ${missing.join('\n  - ')}`);
  return links;
}

async function resolveUser(username) {
  if (!username) return null;
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (!rows.length) throw new Error(`No existe el usuario ${username}`);
  return rows[0].id;
}

// The tagged versions are saved on the Railway volume (same root as src/utils/storage.js). `railway run`
// executes on this machine, where that path does not exist: the real run must happen inside the container.
function assertVolume() {
  const root = getStorageRoot();
  let ok = false;
  try { ok = fs.statSync(root).isDirectory(); } catch { ok = false; }
  if (!ok) throw new Error(`Corre el etiquetado dentro del contenedor de Railway (railway ssh): aquí no existe el volumen ${root}`);
}

async function linkServices(links) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const l of links) await client.query('UPDATE service_catalog SET template_id = $1 WHERE id = $2', [String(l.templateId), l.serviceId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function run({ dryRun = false, file = DEFAULT_FILE, tagger = tagModel, user = null, log = console.log } = {}) {
  const entries = readEntries(file);
  const models = await resolveModels(entries);
  const links = await resolveServices(models);
  const userId = await resolveUser(user);
  const status = new Map((await Tags.listStatuses()).map((s) => [s.id, s]));
  const toTag = [];
  const skipped = [];
  for (const m of models) {
    const s = status.get(m.id);
    if (s && s.status !== 'untagged') skipped.push({ id: m.id, name: m.name, why: `ya etiquetado (${s.status})` });
    else if (!originalFile(m)) skipped.push({ id: m.id, name: m.name, why: 'sin Word (.docx)' });
    else toTag.push(m);
  }

  log(`${dryRun ? '[dry-run] ' : ''}${models.length} modelos resueltos en doc_templates`);
  log(`Servicios a ligar (${links.length}):`);
  for (const l of links) {
    const prev = l.previous && String(l.previous) !== String(l.templateId) ? ` (antes: ${l.previous})` : '';
    log(`  - ${l.service} → #${l.templateId} ${l.model}${prev}`);
  }
  log(`Modelos a etiquetar con IA (${toTag.length}):`);
  for (const m of toTag) log(`  - #${m.id} ${m.name}`);
  if (skipped.length) {
    log(`Sin etiquetar (${skipped.length}):`);
    for (const s of skipped) log(`  - #${s.id} ${s.name}: ${s.why}`);
  }
  const result = { dryRun, models, links, toTag, skipped, tagged: 0, failed: [] };
  if (dryRun) {
    log('[dry-run] No se escribió nada.');
    return result;
  }

  assertVolume(); // before any write
  await linkServices(links);
  log(`Ligados ${links.length} servicios.`);
  const nameOf = new Map(toTag.map((m) => [m.id, m.name]));
  const { failed } = await tagModels(toTag.map((m) => m.id), userId, {
    tagger,
    onStart: (id) => log(`Etiquetando #${id} ${nameOf.get(id)}…`),
    onDone: (id, err) => log(err ? `  falló: ${err.message}` : '  listo'),
  });
  result.failed = failed.map((f) => ({ ...f, name: nameOf.get(f.id) }));
  result.tagged = toTag.length - failed.length;
  log(`Etiquetados ${result.tagged} de ${toTag.length}; fallaron ${failed.length}.`);
  for (const f of result.failed) log(`  - #${f.id} ${f.name}: ${f.error}`);
  log('Pendientes de aprobación: un admin los revisa en Documentos → Etiquetas.');
  return result;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const user = (args.find((a) => a.startsWith('--user=')) || '').slice('--user='.length) || null;
  run({ dryRun: args.includes('--dry-run'), user })
    .then((r) => process.exit(r.failed.length ? 2 : 0))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { run };
