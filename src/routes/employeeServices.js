const express = require('express');
const router = express.Router();
const EmployeeService = require('../models/EmployeeService');
const User = require('../models/User');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

// Get services (filtered by role)
router.get('/', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    const services = isAdmin
      ? await EmployeeService.getAll(startDate, endDate)
      : await EmployeeService.getByUserId(userId, startDate, endDate);

    res.json(services);
  } catch (error) {
    console.error('Get services error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create service (admin only)
router.post('/', requireRole('admin'), async (req, res) => {
  try {
    const { username, serviceName, client, earnings, date } = req.body;

    if (!username || !serviceName || earnings === undefined) {
      return res.status(400).json({
        error: 'Username, service name, and earnings are required',
      });
    }

    const now = new Date();
    const options = {
      timeZone: 'America/Santo_Domingo',
      hour: 'numeric',
      minute: 'numeric',
      hour12: true,
    };
    const autoTime = new Intl.DateTimeFormat('en-US', options).format(now);

    const employee = await User.findByUsernameOrEmail(username);
    if (!employee) {
      return res.status(404).json({ error: 'Employee not found' });
    }
    if (employee.role === 'admin') {
      return res.status(400).json({ error: 'Can only add services for non-admin employees' });
    }

    const service = await EmployeeService.create(
      employee.id,
      serviceName,
      client || null,
      autoTime,
      parseFloat(earnings),
      date || null
    );

    res.status(201).json(service);
  } catch (error) {
    console.error('Create service error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user statistics
router.get('/stats/user/:userId?', async (req, res) => {
  try {
    const userId = req.user.role === 'admin' ? parseInt(req.params.userId) : req.user.id;
    const stats = await EmployeeService.getUserStats(userId);
    res.json(stats);
  } catch (error) {
    console.error('Get user stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get admin dashboard stats (admin only)
router.get('/stats/admin', requireRole('admin'), async (req, res) => {
  try {
    const allUsersStats = await EmployeeService.getAllUsersStats();
    const adminTotal = await EmployeeService.getAdminTotalEarnings();

    res.json({
      users: allUsersStats,
      adminTotal: {
        totalEarnings: parseFloat(adminTotal.total_admin_earnings || 0),
        totalServices: parseInt(adminTotal.total_services || 0),
        activeEmployees: parseInt(adminTotal.active_employees || 0),
      },
    });
  } catch (error) {
    console.error('Get admin stats error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete service
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.role === 'admin' ? null : req.user.id;

    const deletedService = await EmployeeService.delete(id, userId);
    if (!deletedService) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json({ message: 'Service deleted successfully' });
  } catch (error) {
    console.error('Delete service error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update comment
router.put('/:id/comment', async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;

    const updatedService = await EmployeeService.updateComment(id, comment);
    if (!updatedService) {
      return res.status(404).json({ error: 'Service not found' });
    }

    res.json(updatedService);
  } catch (error) {
    console.error('Update comment error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
