const pool = require('../config/database');

class Service {
  static async create(userId, serviceName, client, time, earnings, date = null) {
    const result = await pool.query(
      `INSERT INTO services (user_id, service_name, client, time, earnings, date) 
       VALUES ($1, $2, $3, $4, $5, $6) 
       RETURNING *`,
      [userId, serviceName, client, time, earnings, date || new Date()]
    );
    return result.rows[0];
  }

  static async getByUserId(userId, startDate = null, endDate = null) {
    let query = `
      SELECT s.*, u.username, u.data_column 
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

    query += ' ORDER BY s.date DESC, s.created_at DESC';

    const result = await pool.query(query, params);
    return result.rows;
  }

  static async getAll(startDate = null, endDate = null) {
    let query = `
      SELECT s.*, u.username, u.data_column 
      FROM services s
      JOIN users u ON s.user_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (startDate) {
      params.push(startDate);
      query += ` AND s.date >= $${params.length}`;
    }

    if (endDate) {
      params.push(endDate);
      query += ` AND s.date <= $${params.length}`;
    }

    query += ' ORDER BY s.date DESC, s.created_at DESC';

    const result = await pool.query(query, params);
    return result.rows;
  }

  static async getUserStats(userId) {
    const result = await pool.query(
      `SELECT 
        COUNT(*) as total_services,
        SUM(earnings) as total_earnings,
        SUM(earnings) * 0.5 as user_share,
        SUM(earnings) * 0.5 as admin_share
       FROM services 
       WHERE user_id = $1`,
      [userId]
    );
    return result.rows[0];
  }

  static async getAllUsersStats() {
    const result = await pool.query(
      `SELECT 
        u.id,
        u.username,
        u.data_column,
        COUNT(s.id) as total_services,
        COALESCE(SUM(s.earnings), 0) as total_earnings,
        COALESCE(SUM(s.earnings) * 0.5, 0) as user_share,
        COALESCE(SUM(s.earnings) * 0.5, 0) as admin_share
       FROM users u
       LEFT JOIN services s ON u.id = s.user_id
       WHERE u.role = 'employee'
       GROUP BY u.id, u.username, u.data_column
       ORDER BY u.username`
    );
    return result.rows;
  }

  static async getAdminTotalEarnings() {
    const result = await pool.query(
      `SELECT 
        SUM(earnings) * 0.5 as total_admin_earnings,
        COUNT(*) as total_services,
        COUNT(DISTINCT user_id) as active_employees
       FROM services`
    );
    return result.rows[0];
  }

  static async delete(id, userId = null) {
    let query = 'DELETE FROM services WHERE id = $1';
    const params = [id];

    if (userId) {
      params.push(userId);
      query += ` AND user_id = $${params.length}`;
    }

    query += ' RETURNING *';

    const result = await pool.query(query, params);
    return result.rows[0];
  }
}

module.exports = Service;
