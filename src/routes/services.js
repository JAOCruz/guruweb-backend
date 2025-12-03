const express = require('express');
const router = express.Router();
const servicesController = require('../controllers/servicesController');
const { authMiddleware, isAdmin } = require('../middleware/auth');

// All routes require authentication
router.use(authMiddleware);

// Get services (filtered by role)
router.get('/', servicesController.getServices);

// Create service (admin only)
router.post('/', isAdmin, servicesController.createService);

// Get user statistics
router.get('/stats/user/:userId?', servicesController.getUserStats);

// Get admin dashboard stats (admin only)
router.get('/stats/admin', isAdmin, servicesController.getAdminStats);

// Delete service
router.delete('/:id', servicesController.deleteService);

// Update comment (employees can update their own service comments)
router.patch('/:id/comment', servicesController.updateComment);

module.exports = router;
