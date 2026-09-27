// Birth dates travel as 'YYYY-MM-DD' strings; '' or null clears the field.
function normalizeBirthDate(value) {
  if (value === '' || value === null) return { ok: true, value: null };
  const m = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) {
    const [y, mo, d] = m.slice(1).map(Number);
    const date = new Date(Date.UTC(y, mo - 1, d));
    const real = date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
    if (real && y >= 1900 && date <= new Date()) return { ok: true, value };
  }
  return { ok: false, code: 'INVALID_BIRTH_DATE', error: 'Fecha de nacimiento no válida' };
}

// pg returns DATE columns as local-midnight Date objects; send them back as 'YYYY-MM-DD'
function formatBirthDate(value) {
  if (!(value instanceof Date)) return value ?? null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

module.exports = { normalizeBirthDate, formatBirthDate };
