const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { authMiddleware, isAdmin } = require('../middleware/auth');

// All settings routes require authentication
router.use(authMiddleware);

// Get current employee percentage (accessible to all authenticated users)
router.get('/current', settingsController.getCurrentPercentage);

// Get percentage for a specific date (accessible to all authenticated users)
router.get('/percentage', settingsController.getPercentageForDate);

// Get all settings history (admin only)
router.get('/history', isAdmin, settingsController.getAllSettings);

// Update employee percentage (admin only)
router.post('/percentage', isAdmin, settingsController.updatePercentage);

// Delete a setting (admin only)
router.delete('/:id', isAdmin, settingsController.deleteSetting);

module.exports = router;
