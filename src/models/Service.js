// backend/src/models/Service.js
const pool = require("../config/database");

const Service = {
  async getAll(startDate, endDate) {
    let query = `
      SELECT 
        s.id,
        s.user_id,
        s.service_name,
        s.client,
        s.time,
        s.earnings,
        s.date,
        s.created_at,
        u.username,
        u.data_column
      FROM services s
      JOIN users u ON s.user_id = u.id
    `;

    const params = [];
    const conditions = [];

    if (startDate) {
      conditions.push(`s.date >= $${params.length + 1}`);
      params.push(startDate);
    }

    if (endDate) {
      conditions.push(`s.date <= $${params.length + 1}`);
      params.push(endDate);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " ORDER BY s.date DESC, s.created_at DESC";

    const result = await pool.query(query, params);
    return result.rows;
  },

  async getByUserId(userId, startDate, endDate) {
    let query = `
      SELECT 
        s.id,
        s.user_id,
        s.service_name,
        s.client,
        s.time,
        s.earnings,
        s.date,
        s.created_at,
        u.username,
        u.data_column
      FROM services s
      JOIN users u ON s.user_id = u.id
      WHERE s.user_id = $1
    `;

    const params = [userId];

    if (startDate) {
      params.push(startDate);
      query += ` AND s.date >= $${params.length}`;
    }

    if (endDate) {
      params.push(endDate);
      query += ` AND s.date <= $${params.length}`;
    }

    query += " ORDER BY s.date DESC, s.created_at DESC";

    const result = await pool.query(query, params);
    return result.rows;
  },

  async create(userId, serviceName, client, time, earnings, date) {
    const result = await pool.query(
      `INSERT INTO services (user_id, service_name, client, time, earnings, date)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        userId,
        serviceName,
        client,
        time,
        earnings,
        date || new Date().toISOString().split("T")[0],
      ]
    );
    return result.rows[0];
  },

  async getUserStats(userId) {
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total_services,
        COALESCE(SUM(earnings), 0) as total_earnings,
        COALESCE(SUM(earnings) * 0.5, 0) as user_share
       FROM services
       WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0];
  },

  async getAllUsersStats() {
    const result = await pool.query(
      `SELECT 
        u.id,
        u.username,
        u.data_column,
        COUNT(s.id) as total_services,
        COALESCE(SUM(s.earnings), 0) as total_earnings,
        COALESCE(SUM(s.earnings) * 0.5, 0) as user_share
       FROM users u
       LEFT JOIN services s ON u.id = s.user_id
       WHERE u.role = 'employee'
       GROUP BY u.id, u.username, u.data_column
       ORDER BY u.username`
    );
    return result.rows;
  },

  async getAdminTotalEarnings() {
    const result = await pool.query(
      `SELECT 
        COALESCE(SUM(earnings) * 0.5, 0) as total_admin_earnings,
        COUNT(*) as total_services,
        COUNT(DISTINCT user_id) as active_employees
       FROM services`
    );
    return result.rows[0];
  },

  async delete(id, userId = null) {
    let query = "DELETE FROM services WHERE id = $1";
    const params = [id];

    if (userId) {
      query += " AND user_id = $2";
      params.push(userId);
    }

    query += " RETURNING *";

    const result = await pool.query(query, params);
    return result.rows[0];
  },
};

module.exports = Service;
