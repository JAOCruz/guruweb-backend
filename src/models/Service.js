const pool = require('../db/pool');

const Service = {
  async create({ name, description, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type }) {
    const { rows } = await pool.query(
      `INSERT INTO service_catalog (name, description, category_id, digitacion_price, notarizacion_price, price_tiers, unit_type, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       RETURNING *`,
      [name, description || null, category_id || null, digitacion_price || null, notarizacion_price || null, JSON.stringify(price_tiers || []), unit_type || 'por documento']
    );
    return rows[0];
  },

  async findAll() {
    const { rows } = await pool.query(
      `SELECT s.*, sc.name as category_name, sc.abbreviation as category_abbr, sc.color as category_color
       FROM service_catalog s
       LEFT JOIN service_categories sc ON sc.id = s.category_id
       WHERE s.active = true
       ORDER BY sc.name, s.name`
    );
    return rows;
  },

  async findByCategory(categoryName) {
    const { rows } = await pool.query(
      `SELECT s.*, sc.name as category_name
       FROM service_catalog s
       LEFT JOIN service_categories sc ON sc.id = s.category_id
       WHERE sc.name = $1 AND s.active = true
       ORDER BY s.name`,
      [categoryName]
    );
    return rows;
  },

  async findByName(name) {
    const { rows } = await pool.query(
      `SELECT s.*, sc.name as category_name
       FROM service_catalog s
       LEFT JOIN service_categories sc ON sc.id = s.category_id
       WHERE LOWER(s.name) LIKE LOWER($1) AND s.active = true
       LIMIT 1`,
      [`%${name}%`]
    );
    return rows[0] || null;
  },

  async findById(id) {
    const { rows } = await pool.query(
      `SELECT s.*, sc.name as category_name
       FROM service_catalog s
       LEFT JOIN service_categories sc ON sc.id = s.category_id
       WHERE s.id = $1`,
      [id]
    );
    return rows[0] || null;
  },

  async getCategories() {
    const { rows } = await pool.query(
      `SELECT id, name, description, abbreviation, color, category_type
       FROM service_categories
       WHERE active = true
       ORDER BY name`
    );
    return rows;
  },

  async update(id, fields) {
    const keys = Object.keys(fields);
    const values = Object.values(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
    const { rows } = await pool.query(
      `UPDATE service_catalog SET ${sets}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
      [...values, id]
    );
    return rows[0] || null;
  },

  async delete(id) {
    await pool.query(`UPDATE service_catalog SET active = false WHERE id = $1`, [id]);
  },
};

module.exports = Service;
