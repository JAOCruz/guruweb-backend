const Settings = require('../models/Settings');

const settingsController = {
  // Get current employee percentage
  async getCurrentPercentage(req, res) {
    try {
      const percentage = await Settings.getCurrentPercentage();
      res.json({ percentage });
    } catch (error) {
      console.error('Get current percentage error:', error);
      res.status(500).json({ error: 'Error al obtener el porcentaje' });
    }
  },

  // Get percentage for a specific date
  async getPercentageForDate(req, res) {
    try {
      const { date } = req.query;
      const percentage = await Settings.getPercentageForDate(date ? new Date(date) : new Date());
      res.json({ percentage, date: date || new Date().toISOString().split('T')[0] });
    } catch (error) {
      console.error('Get percentage for date error:', error);
      res.status(500).json({ error: 'Error al obtener el porcentaje' });
    }
  },

  // Get all settings history
  async getAllSettings(req, res) {
    try {
      const settings = await Settings.getAll();
      res.json(settings);
    } catch (error) {
      console.error('Get all settings error:', error);
      res.status(500).json({ error: 'Error al obtener el historial de configuraciones' });
    }
  },

  // Update employee percentage (admin only)
  async updatePercentage(req, res) {
    try {
      const { percentage, effectiveDate } = req.body;

      // Validation
      if (percentage === undefined || percentage === null) {
        return res.status(400).json({ error: 'El porcentaje es requerido' });
      }

      const percentageValue = parseFloat(percentage);
      if (isNaN(percentageValue) || percentageValue < 0 || percentageValue > 100) {
        return res.status(400).json({ error: 'El porcentaje debe estar entre 0 y 100' });
      }

      if (!effectiveDate) {
        return res.status(400).json({ error: 'La fecha de inicio es requerida' });
      }

      const setting = await Settings.updatePercentage(percentageValue, effectiveDate);
      res.json({
        message: 'Porcentaje actualizado exitosamente',
        setting
      });
    } catch (error) {
      console.error('Update percentage error:', error);
      res.status(500).json({ error: 'Error al actualizar el porcentaje' });
    }
  },

  // Delete a setting (admin only, use with caution)
  async deleteSetting(req, res) {
    try {
      const { id } = req.params;
      const deleted = await Settings.delete(id);

      if (!deleted) {
        return res.status(404).json({ error: 'Configuración no encontrada' });
      }

      res.json({ message: 'Configuración eliminada exitosamente', deleted });
    } catch (error) {
      console.error('Delete setting error:', error);
      res.status(500).json({ error: 'Error al eliminar la configuración' });
    }
  }
};

module.exports = settingsController;
