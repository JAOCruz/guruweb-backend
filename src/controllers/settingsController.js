const Settings = require("../models/Settings");

class SettingsController {
  // Get all settings
  async getAllSettings(req, res) {
    try {
      const settings = await Settings.getAllSettings();
      res.json({ success: true, settings });
    } catch (error) {
      console.error("Error fetching settings:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch settings",
      });
    }
  }

  // Get employee percentage
  async getEmployeePercentage(req, res) {
    try {
      const setting = await Settings.getSetting("employee_percentage");
      if (!setting) {
        return res.json({
          success: true,
          percentage: 50, // Default value
        });
      }
      res.json({
        success: true,
        percentage: parseFloat(setting.setting_value),
      });
    } catch (error) {
      console.error("Error fetching employee percentage:", error);
      res.status(500).json({
        success: false,
        error: "Failed to fetch employee percentage",
      });
    }
  }

  // Update employee percentage (admin only)
  async updateEmployeePercentage(req, res) {
    try {
      const { percentage } = req.body;

      if (percentage === undefined || percentage === null) {
        return res.status(400).json({
          success: false,
          error: "Percentage is required",
        });
      }

      const numPercentage = parseFloat(percentage);

      if (isNaN(numPercentage) || numPercentage < 0 || numPercentage > 100) {
        return res.status(400).json({
          success: false,
          error: "Percentage must be a number between 0 and 100",
        });
      }

      const updatedSetting =
        await Settings.updateEmployeePercentage(numPercentage);

      res.json({
        success: true,
        message: "Employee percentage updated successfully",
        setting: updatedSetting,
      });
    } catch (error) {
      console.error("Error updating employee percentage:", error);
      res.status(500).json({
        success: false,
        error: "Failed to update employee percentage",
      });
    }
  }
}

module.exports = new SettingsController();
