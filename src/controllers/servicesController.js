const Service = require("../models/Service");
const User = require("../models/User");

const servicesController = {
  async getServices(req, res) {
    try {
      const { startDate, endDate } = req.query;
      const userId = req.user.id;
      const isAdmin = req.user.role === "admin";

      let services;

      if (isAdmin) {
        // Admin sees all services
        services = await Service.getAll(startDate, endDate);
      } else {
        // Employees only see their own services
        services = await Service.getByUserId(userId, startDate, endDate);
      }

      res.json(services);
    } catch (error) {
      console.error("Get services error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
  async createService(req, res) {
    try {
      const { username, serviceName, client, earnings, date } = req.body; // Remove 'time' from destructuring

      if (!username || !serviceName || !earnings) {
        return res.status(400).json({
          error: "Username, service name, and earnings are required",
        });
      }

      // Auto-generate time in Santo Domingo timezone (Dominican Republic)
      const now = new Date();
      const options = {
        timeZone: "America/Santo_Domingo",
        hour: "numeric",
        minute: "numeric",
        hour12: true,
      };
      const autoTime = new Intl.DateTimeFormat("en-US", options).format(now);

      // Find employee by username or data_column (single query, case insensitive)
      const employee = await User.findByUsernameOrColumn(username);

      if (!employee) {
        return res.status(404).json({ error: "Employee not found" });
      }

      if (employee.role !== "employee") {
        return res
          .status(400)
          .json({ error: "Can only add services for employees" });
      }

      const service = await Service.create(
        employee.id,
        serviceName,
        client || null,
        autoTime,
        parseFloat(earnings),
        date || null,
      );

      res.status(201).json(service);
    } catch (error) {
      console.error("Create service error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async getUserStats(req, res) {
    try {
      const userId =
        req.user.role === "admin" ? parseInt(req.params.userId) : req.user.id;

      const stats = await Service.getUserStats(userId);
      res.json(stats);
    } catch (error) {
      console.error("Get user stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async getAdminStats(req, res) {
    try {
      if (req.user.role !== "admin") {
        return res.status(403).json({ error: "Admin access required" });
      }

      const allUsersStats = await Service.getAllUsersStats();
      const adminTotal = await Service.getAdminTotalEarnings();

      res.json({
        users: allUsersStats,
        adminTotal: {
          totalEarnings: parseFloat(adminTotal.total_admin_earnings || 0),
          totalServices: parseInt(adminTotal.total_services || 0),
          activeEmployees: parseInt(adminTotal.active_employees || 0),
        },
      });
    } catch (error) {
      console.error("Get admin stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async deleteService(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user.role === "admin" ? null : req.user.id;

      const deletedService = await Service.delete(id, userId);

      if (!deletedService) {
        return res.status(404).json({ error: "Service not found" });
      }

      res.json({ message: "Service deleted successfully" });
    } catch (error) {
      console.error("Delete service error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async updateComment(req, res) {
    try {
      const { id } = req.params;
      const { comment } = req.body;

      const updatedService = await Service.updateComment(id, comment);

      if (!updatedService) {
        return res.status(404).json({ error: "Service not found" });
      }

      res.json(updatedService);
    } catch (error) {
      console.error("Update comment error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};

module.exports = servicesController;
