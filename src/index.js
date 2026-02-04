const express = require("express");
const cors = require("cors");
require("dotenv").config();

const authRoutes = require("./routes/auth");
const servicesRoutes = require("./routes/services");

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Middleware - Permite múltiples puertos en desarrollo
const allowedOrigins = [
  "https://gurusoluciones.netlify.app",
  "https://gurusolucionesrd.com",
  "http://localhost:5173",
  "http://localhost:5174", // Puerto alternativo de Vite
  "http://localhost:5175", // Por si acaso
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Permite requests sin origin (como Postman, curl, etc.)
      if (!origin) return callback(null, true);

      if (
        allowedOrigins.indexOf(origin) !== -1 ||
        process.env.NODE_ENV !== "production"
      ) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// Routes
app.use("/api/auth", authRoutes);
app.use("/api/services", servicesRoutes);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "Guruweb API",
    version: "1.0.0",
    endpoints: {
      auth: "/api/auth",
      services: "/api/services",
      health: "/health",
    },
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handler
app.use((err, req, res, next) => {
  console.error("Error:", err);
  res.status(500).json({
    error: "Internal server error",
    message: process.env.NODE_ENV === "development" ? err.message : undefined,
  });
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔗 API: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`✅ CORS enabled for: ${allowedOrigins.join(", ")}`);
});

module.exports = app;
