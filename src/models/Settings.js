const pool = require('../config/database');

class Settings {
  static async getSetting(key) {
    const result = await pool.query(
      'SELECT * FROM settings WHERE setting_key = $1',
      [key]
    );
    return result.rows[0];
  }

  static async getAllSettings() {
    const result = await pool.query(
      'SELECT * FROM settings ORDER BY setting_key'
    );
    return result.rows;
  }

  static async updateSetting(key, value) {
    const result = await pool.query(
      `UPDATE settings
       SET setting_value = $1
       WHERE setting_key = $2
       RETURNING *`,
      [value, key]
    );
    return result.rows[0];
  }

  static async createSetting(key, value, description = null) {
    const result = await pool.query(
      `INSERT INTO settings (setting_key, setting_value, description)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [key, value, description]
    );
    return result.rows[0];
  }

  // Get employee percentage as a decimal (e.g., 50 -> 0.5)
  static async getEmployeePercentage() {
    const setting = await this.getSetting('employee_percentage');
    if (!setting) {
      return 0.5; // Default 50%
    }
    return parseFloat(setting.setting_value) / 100;
  }

  // Update employee percentage (accepts 0-100)
  static async updateEmployeePercentage(percentage, userId = null, startDate = null) {
    const value = Math.max(0, Math.min(100, parseFloat(percentage))); // Clamp between 0-100
    const decimal = value / 100;
    const effectiveDate = startDate || new Date().toISOString().split('T')[0];

    // Start a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete any history records that start on or after the effective date
      // This allows retroactive changes
      await client.query(
        `DELETE FROM settings_history
         WHERE start_date >= $1`,
        [effectiveDate]
      );

      // Close the current active record (set end_date to day before effective date)
      await client.query(
        `UPDATE settings_history
         SET end_date = $1::date - interval '1 day'
         WHERE end_date IS NULL AND start_date < $1::date`,
        [effectiveDate]
      );

      // Create new history record starting from effective date
      await client.query(
        `INSERT INTO settings_history (employee_percentage, start_date, created_by)
         VALUES ($1, $2, $3)`,
        [decimal, effectiveDate, userId]
      );

      // Update settings table for current value
      await client.query(
        `UPDATE settings
         SET setting_value = $1
         WHERE setting_key = 'employee_percentage'`,
        [value.toString()]
      );

      await client.query('COMMIT');

      return { employee_percentage: value };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

module.exports = Settings;
