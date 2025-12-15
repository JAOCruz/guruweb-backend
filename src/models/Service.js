// backend/src/models/Service.js
const pool = require("../config/database");

/**
 * Resolve employee percentage by service date
 */
async function getEmployeePercentageByDate(date) {
  const result = await pool.query(
    `
    SELECT employee_percentage
    FROM settings_history
    WHERE start_date <= $1
      AND (end_date IS NULL OR end_date >= $1)
    ORDER BY start_date DESC
    LIMIT 1
    `,
    [date]
  );

  return result.rows[0]?.employee_percentage ?? 0.5;
}

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
        s.comment,
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
        s.comment,
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
      `
      INSERT INTO services (user_id, service_name, client, time, earnings, date)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
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
    const services = await pool.query(
      `SELECT earnings, date FROM services WHERE user_id = $1`,
      [userId]
    );

    let totalEarnings = 0;
    let userShare = 0;

    for (const service of services.rows) {
      const pct = await getEmployeePercentageByDate(service.date);
      totalEarnings += Number(service.earnings);
      userShare += Number(service.earnings) * pct;
    }

    return {
      total_services: services.rowCount,
      total_earnings: totalEarnings,
      user_share: userShare,
    };
  },

  async getAllUsersStats() {
    const users = await pool.query(
      `SELECT id, username, data_column FROM users WHERE role = 'employee'`
    );

    const stats = [];

    for (const user of users.rows) {
      const services = await pool.query(
        `SELECT earnings, date FROM services WHERE user_id = $1`,
        [user.id]
      );

      let totalEarnings = 0;
      let userShare = 0;

      for (const s of services.rows) {
        const pct = await getEmployeePercentageByDate(s.date);
        totalEarnings += Number(s.earnings);
        userShare += Number(s.earnings) * pct;
      }

      stats.push({
        id: user.id,
        username: user.username,
        data_column: user.data_column,
        total_services: services.rowCount,
        total_earnings: totalEarnings,
        user_share: userShare,
      });
    }

    return stats;
  },

  async getAdminTotalEarnings() {
    const services = await pool.query(
      `SELECT earnings, date, user_id FROM services`
    );

    let totalAdminEarnings = 0;
    const users = new Set();

    for (const s of services.rows) {
      const pct = await getEmployeePercentageByDate(s.date);
      totalAdminEarnings += Number(s.earnings) * (1 - pct);
      users.add(s.user_id);
    }

    return {
      total_admin_earnings: totalAdminEarnings,
      total_services: services.rowCount,
      active_employees: users.size,
    };
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

  async updateComment(id, userId, comment) {
    const result = await pool.query(
      `
      UPDATE services
      SET comment = $1
      WHERE id = $2 AND user_id = $3
      RETURNING *
      `,
      [comment, id, userId]
    );

    return result.rows[0];
  },
};

module.exports = Service;
