// Carga inicial del conocimiento del bot: reglas y alias de los servicios,
// servicios nuevos sin precio en el catálogo, conflictos de precio (por_confirmar)
// y los trámites. Todo en una transacción; se puede correr varias veces sin
// duplicar nada. Con --dry-run imprime el resumen y hace ROLLBACK.
//
//   node -r dotenv/config src/db/seedBotKnowledge.js [--dry-run] [--dir seeds/bot]
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

const FILES = {
  enriquecidos: 'servicios-enriquecidos.json',
  nuevos: 'servicios-nuevos.json',
  conflictos: 'conflictos.json',
  tramites: 'tramites.json',
};
const ENRICH_FIELDS = ['descripcion', 'incluye', 'reglas', 'requisitos', 'alias', 'notarizacion', 'tiempo_entrega', 'precio_rango'];
const JSON_FIELDS = new Set(['precio_rango', 'price_tiers']);

function readSeed(dir, file) {
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return [];
  const data = JSON.parse(fs.readFileSync(full, 'utf8'));
  if (!Array.isArray(data)) throw new Error(`${file} debe ser un arreglo`);
  return data;
}

const param = (field, value) => (JSON_FIELDS.has(field) ? JSON.stringify(value) : value);

async function enrich(client, items, saltados) {
  let n = 0;
  for (const it of items) {
    const sets = [];
    const vals = [it.nombre];
    for (const f of ENRICH_FIELDS) {
      if (it[f] === undefined) continue;
      vals.push(param(f, it[f]));
      sets.push(`${f} = $${vals.length}${f === 'alias' ? '::text[]' : f === 'precio_rango' ? '::jsonb' : ''}`);
    }
    if (!sets.length) continue;
    const r = await client.query(`UPDATE service_catalog SET ${sets.join(', ')} WHERE name = $1`, vals);
    if (r.rowCount === 0) saltados.push(it.nombre);
    else n += 1;
  }
  return n;
}

async function insertNew(client, items, saltados) {
  const cats = (await client.query(`SELECT id, name FROM service_categories`)).rows;
  const catId = Object.fromEntries(cats.map((c) => [c.name, c.id]));
  let n = 0;
  for (const it of items) {
    const exists = await client.query(`SELECT 1 FROM service_catalog WHERE name = $1 LIMIT 1`, [it.nombre]);
    if (exists.rows.length) continue; // ya está: nunca se toca su precio
    const cid = catId[it.categoria];
    if (!cid) { saltados.push(it.nombre); continue; }
    await client.query(
      `INSERT INTO service_catalog (name, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type, active,
         alias, incluye, reglas, requisitos, descripcion, precio_rango, por_confirmar, notarizacion, tiempo_entrega)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, $5, true, $6::text[], $7, $8, $9, $10, $11::jsonb, $12, $13, $14)`,
      [it.nombre, cid, it.digitacion_price ?? null, it.notarizacion_price ?? null, it.unit_type || 'por documento',
        it.alias || [], it.incluye || null, it.reglas || null, it.requisitos || null, it.descripcion || null,
        it.precio_rango ? JSON.stringify(it.precio_rango) : null, it.por_confirmar === true,
        it.notarizacion || null, it.tiempo_entrega || null]
    );
    n += 1;
  }
  return n;
}

async function flagConflicts(client, items, saltados) {
  let n = 0;
  for (const it of items) {
    if (it.grupo) {
      const desde = Number(it.tramos_desde);
      const { rows } = await client.query(
        `SELECT id, price_tiers FROM service_catalog WHERE name LIKE $1 AND price_tiers IS NOT NULL AND jsonb_typeof(price_tiers) = 'array'`,
        [`${it.grupo}%`]
      );
      for (const s of rows) {
        const tiers = s.price_tiers.map((t) => (Number(t.min) >= desde ? { ...t, por_confirmar: true } : t));
        if (JSON.stringify(tiers) === JSON.stringify(s.price_tiers)) { n += 1; continue; }
        await client.query(`UPDATE service_catalog SET price_tiers = $2::jsonb WHERE id = $1`, [s.id, JSON.stringify(tiers)]);
        n += 1;
      }
      continue;
    }
    const nota = `Precio por confirmar: ${it.motivo}`;
    const r = await client.query(
      `UPDATE service_catalog
         SET por_confirmar = true,
             reglas = CASE WHEN reglas IS NULL OR reglas = '' THEN $2
                           WHEN position($2 in reglas) > 0 THEN reglas
                           ELSE reglas || E'\n' || $2 END
       WHERE name = $1`,
      [it.nombre, nota]
    );
    if (r.rowCount === 0) saltados.push(it.nombre);
    else n += 1;
  }
  return n;
}

async function upsertTramites(client, items) {
  let n = 0;
  for (const t of items) {
    const pasos = (t.pasos || []).map((p, i) => ({
      orden: p.orden ?? i + 1,
      descripcion: p.descripcion,
      servicio: p.servicio || null,
      preguntas: p.preguntas || [],
    }));
    await client.query(
      `INSERT INTO tramites (nombre, alias, pasos, preguntas_obligatorias, reglas, activo)
       VALUES ($1, $2::text[], $3::jsonb, $4::text[], $5, true)
       ON CONFLICT (nombre) DO UPDATE SET alias = EXCLUDED.alias, pasos = EXCLUDED.pasos,
         preguntas_obligatorias = EXCLUDED.preguntas_obligatorias, reglas = EXCLUDED.reglas, activo = true`,
      [t.nombre, t.alias || [], JSON.stringify(pasos), t.preguntas_obligatorias || [], t.reglas || null]
    );
    n += 1;
  }
  return n;
}

async function seedBotKnowledge({ dir = path.join(__dirname, '..', '..', 'seeds', 'bot'), dryRun = false } = {}) {
  const seeds = {};
  for (const [k, f] of Object.entries(FILES)) seeds[k] = readSeed(dir, f);
  const saltados = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const enriquecidos = await enrich(client, seeds.enriquecidos, saltados);
    const nuevos = await insertNew(client, seeds.nuevos, saltados);
    const conflictos = await flagConflicts(client, seeds.conflictos, saltados);
    const tramites = await upsertTramites(client, seeds.tramites);
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { enriquecidos, nuevos, conflictos, tramites, saltados };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const dirIdx = args.indexOf('--dir');
  const dir = dirIdx >= 0 ? path.resolve(args[dirIdx + 1]) : undefined;
  try {
    const r = await seedBotKnowledge({ dir, dryRun });
    console.log(`${dryRun ? '[dry-run, sin cambios] ' : ''}Enriquecidos: ${r.enriquecidos} · Nuevos: ${r.nuevos} · Conflictos: ${r.conflictos} · Trámites: ${r.tramites}`);
    if (r.saltados.length) console.log(`Saltados (${r.saltados.length}): ${r.saltados.join(' | ')}`);
    process.exit(0);
  } catch (err) {
    console.error('Seed falló:', err.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

if (require.main === module) main();

module.exports = { seedBotKnowledge };
