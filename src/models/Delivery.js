// Envíos al cliente (tabla deliveries). Estados: por_enviar → enviado → entregado, o cancelado.
const pool = require('../db/pool');

const STATUSES = ['por_enviar', 'enviado', 'entregado', 'cancelado'];
const EDITABLE = ['document', 'address', 'reference', 'recipient_name', 'recipient_phone', 'note'];
// Date saved when entering each status (back to por_enviar clears them: the delivery starts over)
const STAMP = { enviado: 'sent_at', entregado: 'delivered_at', cancelado: 'cancelled_at' };

const SELECT = `SELECT d.*, c.name AS client_name, c.phone AS client_phone, ca.case_number,
  u.name AS created_by_name
  FROM deliveries d
  LEFT JOIN clients c ON c.id = d.client_id
  LEFT JOIN cases ca ON ca.id = d.case_id
  LEFT JOIN users u ON u.id = d.created_by`;

const clean = (v) => (v == null ? null : String(v).trim().slice(0, 2000) || null);

const Delivery = {
  STATUSES,
  EDITABLE,

  async findById(id) {
    const { rows } = await pool.query(`${SELECT} WHERE d.id = $1`, [id]);
    return rows[0] || null;
  },

  async list(status) {
    const where = STATUSES.includes(status) ? 'WHERE d.status = $1' : '';
    const { rows } = await pool.query(`${SELECT} ${where} ORDER BY d.created_at DESC, d.id DESC LIMIT 300`,
      where ? [status] : []);
    return rows;
  },

  async counts() {
    const { rows } = await pool.query('SELECT status, COUNT(*)::int AS n FROM deliveries GROUP BY status');
    const out = Object.fromEntries(STATUSES.map((s) => [s, 0]));
    rows.forEach((r) => { out[r.status] = r.n; });
    return out;
  },

  async openForClient(clientId) {
    const { rows } = await pool.query(
      `SELECT * FROM deliveries WHERE client_id = $1 AND status = 'por_enviar' ORDER BY id DESC LIMIT 1`, [clientId]);
    return rows[0] || null;
  },

  async create({ clientId = null, caseId = null, source = 'manual', createdBy = null, ...fields }) {
    const vals = EDITABLE.map((k) => clean(fields[k]));
    const n = EDITABLE.length;
    const { rows } = await pool.query(
      `INSERT INTO deliveries (${EDITABLE.join(', ')}, client_id, case_id, source, created_by)
       VALUES (${EDITABLE.map((_, i) => `$${i + 1}`).join(', ')}, $${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}) RETURNING id`,
      [...vals, clientId, caseId, source, createdBy]);
    return Delivery.findById(rows[0].id);
  },

  // Only the fields present are changed
  async update(id, fields) {
    const keys = EDITABLE.filter((k) => fields[k] !== undefined);
    if (!keys.length) return Delivery.findById(id);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const { rowCount } = await pool.query(
      `UPDATE deliveries SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${keys.length + 1}`,
      [...keys.map((k) => clean(fields[k])), id]);
    return rowCount ? Delivery.findById(id) : null;
  },

  async setStatus(id, status) {
    const stamp = STAMP[status];
    const extra = stamp ? `, ${stamp} = COALESCE(${stamp}, NOW())`
      : ', sent_at = NULL, delivered_at = NULL, cancelled_at = NULL';
    const { rowCount } = await pool.query(
      `UPDATE deliveries SET status = $1${extra}, updated_at = NOW() WHERE id = $2`, [status, id]);
    return rowCount ? Delivery.findById(id) : null;
  },
};

module.exports = Delivery;
