#!/usr/bin/env node
// Base del bot de prueba: copia de producción SOLO la estructura (tablas vacías) y los datos de referencia que el bot
// usa para cotizar (catálogo, tarifas, trámites, datos del negocio, modelos públicos). Nunca copia clientes, mensajes,
// usuarios, facturas ni casos, ni modelos privados o en la papelera.
//
//   exportar:  railway run --service <backend de producción> node scripts/prueba/copiar-referencia.js exportar
//              (lee producción en modo solo lectura; deja los archivos en ~/.config/guru-bot-prueba/)
//   importar:  railway run --service <backend de prueba> node scripts/prueba/copiar-referencia.js importar
//              (exige GURU_ENTORNO=prueba en ese servicio y se niega si la base es la misma de la exportación)
//   admin:     railway run --service <backend de prueba> node scripts/prueba/copiar-referencia.js admin
//              (crea o renueva el usuario admin_prueba; la contraseña queda en ~/.config/guru-bot-prueba/admin.txt)
//
// La URL de la base sale de DATABASE_URL y se pasa a pg_dump/psql por variables PG* del entorno, nunca por argumentos.
// No imprime URLs ni contraseñas.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Pool } = require('pg');

const DIR = process.env.GURU_PRUEBA_DIR || path.join(os.homedir(), '.config', 'guru-bot-prueba');
const ESQUEMA = path.join(DIR, 'esquema.sql');
const DATOS = path.join(DIR, 'datos.json');
const ADMIN_FILE = path.join(DIR, 'admin.txt');
const PG_BIN = process.env.PG_BIN || (fs.existsSync('/opt/homebrew/opt/libpq/bin') ? '/opt/homebrew/opt/libpq/bin' : '');

// En orden: primero lo que otros referencian.
const TABLAS = [
  'schema_migrations', 'settings',
  'service_categories', 'service_catalog', 'tramites', 'service_procedures', 'pricing_rates', 'business_info', 'tasas_cache',
  'doc_categories', 'doc_roles', 'doc_variables', 'doc_templates', 'doc_template_variables', 'template_tag_versions',
  'law_categories', 'laws',
];
// Filas que no se copian (modelos privados o borrados, y sus versiones).
const FILTRO = {
  doc_templates: `WHERE COALESCE(is_private, false) = false AND deleted_at IS NULL`,
  doc_template_variables: `WHERE template_id IN (SELECT id FROM doc_templates WHERE COALESCE(is_private, false) = false AND deleted_at IS NULL)`,
  template_tag_versions: `WHERE template_id IN (SELECT id FROM doc_templates WHERE COALESCE(is_private, false) = false AND deleted_at IS NULL)`,
};

const mask = (s) => String(s).replace(/postgres(ql)?:\/\/[^\s'"]*/gi, '[url]');
const die = (msg) => { console.error(`✖ ${mask(msg)}`); process.exit(1); };

function url() {
  // Desde la Mac hace falta la URL pública: la de DATABASE_URL puede ser la interna (*.railway.internal).
  const u = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!u) die('Falta DATABASE_URL (corra el comando con railway run --service …)');
  if (/\.railway\.internal$/.test(new URL(u).hostname)) die('La base solo tiene la dirección interna de Railway: agregue al servicio DATABASE_PUBLIC_URL = ${{<Postgres>.DATABASE_PUBLIC_URL}}');
  return new URL(u);
}
const isLocal = (u) => ['localhost', '127.0.0.1'].includes(u.hostname);
function pgEnv(u) {
  return {
    ...process.env, PGHOST: u.hostname, PGPORT: u.port || '5432', PGUSER: decodeURIComponent(u.username),
    PGPASSWORD: decodeURIComponent(u.password), PGDATABASE: u.pathname.replace(/^\//, ''), PGSSLMODE: isLocal(u) ? 'disable' : 'require',
  };
}
const pool = (u) => new Pool({ connectionString: u.toString(), ssl: isLocal(u) ? false : { rejectUnauthorized: false }, keepAlive: true, query_timeout: 120000 });
// Huella de la base (sin datos sensibles) para no importar nunca sobre la misma base de la que se exportó.
async function huella(p) {
  const { rows } = await p.query(`SELECT current_database() AS db, (SELECT system_identifier::text FROM pg_control_system()) AS sys`);
  return crypto.createHash('sha256').update(`${rows[0].db}|${rows[0].sys}`).digest('hex').slice(0, 16);
}
async function existe(p, t) {
  return (await p.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${t}`])).rows[0].ok;
}
// Columnas que apuntan a users: en la base de prueba no hay usuarios de producción, quedan en NULL.
async function columnasDeUsuarios(p, t) {
  const { rows } = await p.query(
    `SELECT a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.contype = 'f' AND c.conrelid = $1::regclass AND c.confrelid = 'public.users'::regclass`, [`public.${t}`]);
  return rows.map((r) => r.col);
}

async function exportar() {
  const u = url();
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const r = spawnSync(path.join(PG_BIN, 'pg_dump'), ['--schema-only', '--no-owner', '--no-privileges', '--schema=public', '-f', ESQUEMA],
    { env: pgEnv(u), encoding: 'utf8' });
  if (r.status !== 0) die(`pg_dump falló: ${(r.stderr || r.error?.message || '').slice(0, 400)}`);
  const p = pool(u);
  const c = await p.connect();
  const out = { exportado: new Date().toISOString(), huella: null, tablas: {} };
  try {
    await c.query('BEGIN READ ONLY');
    out.huella = await huella(c);
    for (const t of TABLAS) {
      if (!(await existe(c, t))) continue;
      const nulos = await columnasDeUsuarios(c, t);
      const { rows } = await c.query(`SELECT * FROM ${t} ${FILTRO[t] || ''}`);
      for (const row of rows) for (const col of nulos) row[col] = null;
      out.tablas[t] = rows;
    }
    await c.query('ROLLBACK');
  } finally { c.release(); await p.end(); }
  fs.writeFileSync(DATOS, JSON.stringify(out), { mode: 0o600 });
  fs.chmodSync(ESQUEMA, 0o600);
  console.log('✔ Exportado (solo lectura):', Object.entries(out.tablas).map(([t, r]) => `${t} ${r.length}`).join(', '));
  console.log(`  Archivos en ${DIR}`);
}

async function importar() {
  if (process.env.GURU_ENTORNO !== 'prueba') die('Este servicio no tiene GURU_ENTORNO=prueba: no se importa nada.');
  if (!fs.existsSync(DATOS) || !fs.existsSync(ESQUEMA)) die(`Falta la exportación en ${DIR}: corra primero «exportar» contra producción.`);
  const datos = JSON.parse(fs.readFileSync(DATOS, 'utf8'));
  const u = url();
  const p = pool(u);
  try {
    if ((await huella(p)) === datos.huella) die('La base de destino es la misma de la exportación (producción). No se importa nada.');
    // Estructura: solo si la base está vacía (primera vez).
    if (!(await existe(p, 'users'))) {
      const sql = fs.readFileSync(ESQUEMA, 'utf8').split('\n')
        .filter((l) => !/^SET transaction_timeout/.test(l) && !/^\\(un)?restrict /.test(l) && !/^(CREATE SCHEMA public;|COMMENT ON SCHEMA public )/.test(l)).join('\n');
      const tmp = path.join(DIR, 'esquema-filtrado.sql');
      fs.writeFileSync(tmp, sql, { mode: 0o600 });
      const r = spawnSync(path.join(PG_BIN, 'psql'), ['-v', 'ON_ERROR_STOP=1', '-q', '-f', tmp], { env: pgEnv(u), encoding: 'utf8' });
      fs.unlinkSync(tmp);
      if (r.status !== 0) die(`No se pudo crear la estructura: ${(r.stderr || '').slice(0, 600)}`);
      console.log('✔ Estructura creada (copia de producción, tablas vacías)');
    }
    const c = await p.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SET LOCAL session_replication_role = replica`); // las llaves entre tablas se cargan en cualquier orden
      const presentes = Object.keys(datos.tablas).filter((t) => TABLAS.includes(t));
      for (const t of presentes) if (await existe(c, t)) await c.query(`DELETE FROM ${t}`);
      for (const t of presentes) {
        if (!(await existe(c, t))) continue;
        const { rows: cols } = await c.query(
          `SELECT column_name, data_type, is_generated FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t]);
        const tipos = new Map(cols.filter((x) => x.is_generated !== 'ALWAYS').map((x) => [x.column_name, x.data_type]));
        // Por lotes: fila por fila, por internet, tarda demasiado (y una conexión que se cae lo deja colgado).
        const filas = datos.tablas[t];
        const keys = [...new Set(filas.flatMap((row) => Object.keys(row)))].filter((k) => tipos.has(k));
        const porLote = Math.max(1, Math.min(500, Math.floor(60000 / Math.max(1, keys.length))));
        for (let i = 0; i < filas.length && keys.length; i += porLote) {
          const lote = filas.slice(i, i + porLote);
          const vals = [];
          const tuplas = lote.map((row) => `(${keys.map((k) => {
            const v = row[k] === undefined ? null : row[k];
            vals.push(v !== null && ['json', 'jsonb'].includes(tipos.get(k)) ? JSON.stringify(v) : v);
            return `$${vals.length}`;
          }).join(', ')})`);
          await c.query(`INSERT INTO ${t} (${keys.map((k) => `"${k}"`).join(', ')}) OVERRIDING SYSTEM VALUE VALUES ${tuplas.join(', ')}`, vals);
        }
        // las secuencias siguen después del último id copiado
        const { rows: seqs } = await c.query(
          `SELECT column_name, pg_get_serial_sequence($1, column_name) AS seq FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $2 AND pg_get_serial_sequence($1, column_name) IS NOT NULL`, [`public.${t}`, t]);
        for (const s of seqs) {
          await c.query(`SELECT setval($1, COALESCE((SELECT MAX("${s.column_name}") FROM ${t}), 0) + 1, false)`, [s.seq]);
        }
      }
      // el usuario 'bot' que crea la migración 20261005_bot_agent (los usuarios no se copian): sin él el agente no anota
      await c.query(`INSERT INTO users (username, name, role, password_hash, is_active, in_payroll)
        VALUES ('bot', 'Bot Gurú', 'digitador', '!', false, false) ON CONFLICT DO NOTHING`);
      await c.query('COMMIT');
    } catch (err) { await c.query('ROLLBACK'); throw err; } finally { c.release(); }
    console.log('✔ Importado:', Object.entries(datos.tablas).map(([t, r]) => `${t} ${r.length}`).join(', '));
    console.log(`  (exportación del ${datos.exportado})`);
  } finally { await p.end(); }
}

async function admin() {
  if (process.env.GURU_ENTORNO !== 'prueba') die('Este servicio no tiene GURU_ENTORNO=prueba: no se crea ningún usuario.');
  const bcrypt = require('bcryptjs');
  const u = url();
  const p = pool(u);
  try {
    const pass = crypto.randomBytes(12).toString('base64url');
    const hash = await bcrypt.hash(pass, 10);
    await p.query(
      `INSERT INTO users (username, name, password_hash, role, created_at, updated_at) VALUES ('admin_prueba', 'Admin (bot de prueba)', $1, 'admin', NOW(), NOW())
       ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin', updated_at = NOW()`, [hash]);
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(ADMIN_FILE, `usuario: admin_prueba\ncontraseña: ${pass}\n`, { mode: 0o600 });
    console.log(`✔ Usuario admin_prueba listo. La contraseña quedó en ${ADMIN_FILE} (no se muestra aquí).`);
  } finally { await p.end(); }
}

const modo = process.argv[2];
const fn = { exportar, importar, admin }[modo];
if (!fn) die('Uso: node scripts/prueba/copiar-referencia.js exportar|importar|admin');
fn().catch((err) => die(err.message));
