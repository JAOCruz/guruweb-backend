const express = require('express');
const router = express.Router();
const settingsController = require('../controllers/settingsController');
const { authMiddleware, isAdmin } = require('../middleware/auth');

// All settings routes require authentication
router.use(authMiddleware);

// Get all settings (requires auth)
router.get('/', settingsController.getAllSettings);

// Get employee percentage (requires auth)
router.get('/employee-percentage', settingsController.getEmployeePercentage);

// Update employee percentage (admin only)
router.put('/employee-percentage', isAdmin, settingsController.updateEmployeePercentage);

module.exports = router;
