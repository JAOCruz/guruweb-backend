const EmployeeService = require("../models/EmployeeService");
const User = require("../models/User");
const { logActivity, rd, safeLog } = require("../services/activityLog");

const servicesController = {
  async getServices(req, res) {
    try {
      const { startDate, endDate } = req.query;
      const userId = req.user.id;
      const isAdmin = req.user.role === "admin";

      let services;

      if (isAdmin) {
        // Admin sees all services
        services = await EmployeeService.getAll(startDate, endDate);
      } else {
        // Employees only see their own services
        services = await EmployeeService.getByUserId(userId, startDate, endDate);
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

      if (employee.role === "admin") {
        return res
          .status(400)
          .json({ error: "Can only add services for non-admin employees" });
      }

      const service = await EmployeeService.create(
        employee.id,
        serviceName,
        client || null,
        autoTime,
        parseFloat(earnings),
        date || null,
      );

      await safeLog(async () => {
        await logActivity(req, {
          category: "servicios", action: "service.create", entityType: "service", entityId: service.id,
          summary: `Agregó el servicio "${serviceName}" a ${employee.name || employee.username} por ${rd(earnings)}${client ? ` (cliente: ${client})` : ""}`,
          details: { employee_id: employee.id, service_name: serviceName, earnings: parseFloat(earnings), client: client || null, date: date || null },
        });
      });
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

      const stats = await EmployeeService.getUserStats(userId);
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
      console.error("Get admin stats error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  async deleteService(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user.role === "admin" ? null : req.user.id;

      const deletedService = await EmployeeService.delete(id, userId);

      if (!deletedService) {
        return res.status(404).json({ error: "Service not found" });
      }

      await safeLog(async () => {
        const owner = deletedService.user_id ? await User.findById(deletedService.user_id) : null;
        await logActivity(req, {
          category: "servicios", action: "service.delete", entityType: "service", entityId: id,
          summary: `Eliminó el servicio "${deletedService.service_name}" de ${owner ? owner.name || owner.username : "un empleado"} por ${rd(deletedService.earnings)}`,
          details: { employee_id: deletedService.user_id, service_name: deletedService.service_name, earnings: deletedService.earnings, client: deletedService.client || null },
        });
      });
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

      const updatedService = await EmployeeService.updateComment(id, comment);

      if (!updatedService) {
        return res.status(404).json({ error: "Service not found" });
      }

      await safeLog(async () => {
        await logActivity(req, {
          category: "servicios", action: "service.comment", entityType: "service", entityId: id,
          summary: `Cambió la nota del servicio "${updatedService.service_name}"`,
          details: { comment: comment || null },
        });
      });
      res.json(updatedService);
    } catch (error) {
      console.error("Update comment error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};

module.exports = servicesController;
