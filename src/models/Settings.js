const pool = require('../config/database');

class Settings {
  // Get current employee percentage for a specific date
  static async getPercentageForDate(date = new Date()) {
    const query = `
      SELECT employee_percentage, effective_date
      FROM settings
      WHERE effective_date <= $1
      ORDER BY effective_date DESC, id DESC
      LIMIT 1
    `;
    const result = await pool.query(query, [date]);

    if (result.rows.length === 0) {
      // Default to 50% if no settings found
      return 50.00;
    }

    return parseFloat(result.rows[0].employee_percentage);
  }

  // Get current employee percentage (for today)
  static async getCurrentPercentage() {
    return await this.getPercentageForDate(new Date());
  }

  // Get all settings history
  static async getAll() {
    const query = `
      SELECT id, employee_percentage, effective_date, created_at
      FROM settings
      ORDER BY effective_date DESC
    `;
    const result = await pool.query(query);
    return result.rows;
  }

  // Update or create new percentage setting
  static async updatePercentage(percentage, effectiveDate) {
    const query = `
      INSERT INTO settings (employee_percentage, effective_date, updated_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP)
      RETURNING id, employee_percentage, effective_date, created_at
    `;
    const result = await pool.query(query, [percentage, effectiveDate]);
    return result.rows[0];
  }

  // Delete a specific setting (admin only, careful!)
  static async delete(id) {
    const query = 'DELETE FROM settings WHERE id = $1 RETURNING *';
    const result = await pool.query(query, [id]);
    return result.rows[0];
  }
}

module.exports = Settings;
