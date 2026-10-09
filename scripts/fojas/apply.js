// Aplica seeds/bot/fojas.json: actualiza foja_tipo y fojas por nombre exacto, en una transacción.
// La unidad pasa a 'por documento': las fojas ya van en el precio (antes, p. ej., las instancias iban 'por hoja').
// Uso: node -r dotenv/config scripts/fojas/apply.js [--dry-run] [--file seeds/bot/fojas.json]
const fs = require('fs');
const path = require('path');

async function applyFojas({ file, dryRun = false }) {
  const pool = require('../../src/db/pool');
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  const client = await pool.connect();
  let aplicados = 0;
  const saltados = [];
  try {
    await client.query('BEGIN');
    for (const it of items) {
      const r = await client.query(
        "UPDATE service_catalog SET foja_tipo = $1, fojas = $2, unit_type = 'por documento' WHERE name = $3",
        [it.foja_tipo, it.fojas, it.nombre]);
      if (r.rowCount > 0) aplicados += 1; else saltados.push(it.nombre);
    }
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  return { aplicados, saltados };
}

module.exports = { applyFojas };

if (require.main === module) {
  const args = process.argv.slice(2);
  const file = path.resolve(args.includes('--file') ? args[args.indexOf('--file') + 1] : 'seeds/bot/fojas.json');
  applyFojas({ file, dryRun: args.includes('--dry-run') })
    .then(async (r) => {
      console.log(`Aplicados: ${r.aplicados} · Saltados: ${r.saltados.length}`);
      if (r.saltados.length) console.log(r.saltados.join('\n'));
      await require('../../src/db/pool').end();
    })
    .catch((e) => { console.error(e.message); process.exit(1); });
}
