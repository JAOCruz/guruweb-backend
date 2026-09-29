const pool = require('../db/pool');

// Ficha legal: person data reused across documents. Keys are normalized base names
// ("NOMBRE", "DOCUMENTO IDENTIDAD", "ESTADO CIVIL"…) without the role suffix.
const norm = (k) =>
  String(k).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();

const PERSON = ['NOMBRE', 'NACIONALIDAD', 'DOCUMENTO IDENTIDAD', 'CEDULA', 'ESTADO CIVIL', 'PROFESION', 'OCUPACION',
  'DIRECCION', 'DIRECCION O DOMICILIO', 'DOMICILIO', 'TELEFONO', 'EMAIL', 'CORREO', 'FECHA DE NACIMIENTO'];

// "NOMBRE_COMPRADOR" in group COMPRADOR → "NOMBRE"
function baseOf(field) {
  const suffix = `_${field.group}`;
  return field.group !== 'DOCUMENTO' && field.key.endsWith(suffix) ? field.key.slice(0, -suffix.length) : field.key;
}

// Which fields belong to the client: those of their role, or person fields when there are no roles
function clientFields(fields, role) {
  return role ? fields.filter((f) => f.group === role) : fields.filter((f) => PERSON.includes(norm(baseOf(f))));
}

function prefill(fields, profile, role) {
  const byNorm = new Map(Object.entries(profile || {}).map(([k, v]) => [norm(k), v]));
  const out = {};
  for (const f of clientFields(fields, role)) {
    const v = byNorm.get(norm(baseOf(f)));
    if (v) out[f.key] = v;
  }
  return out;
}

function updatesFrom(fields, values, role) {
  const out = {};
  for (const f of clientFields(fields, role)) {
    const v = values[f.key];
    if (v && String(v).trim()) out[norm(baseOf(f))] = String(v).trim();
  }
  return out;
}

async function get(clientId) {
  const { rows } = await pool.query('SELECT data FROM legal_profiles WHERE client_id = $1', [clientId]);
  return rows[0]?.data || {};
}

async function merge(clientId, data, userId) {
  if (!Object.keys(data).length) return;
  await pool.query(
    `INSERT INTO legal_profiles (client_id, data, updated_by) VALUES ($1, $2, $3)
     ON CONFLICT (client_id) DO UPDATE SET data = legal_profiles.data || EXCLUDED.data, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [clientId, JSON.stringify(data), userId]
  );
}

module.exports = { get, merge, prefill, updatesFrom, norm };
