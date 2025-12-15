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
  static async updateEmployeePercentage(percentage) {
    const value = Math.max(0, Math.min(100, parseFloat(percentage))); // Clamp between 0-100
    return await this.updateSetting('employee_percentage', value.toString());
  }
}

module.exports = Settings;
