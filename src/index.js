// Polyfill global crypto for Baileys on Node 20 (Railway default)
if (typeof globalThis.crypto === "undefined") {
  try {
    globalThis.crypto = require("crypto").webcrypto;
    console.log("[crypto] polyfilled globalThis.crypto");
  } catch (err) {
    console.warn("[crypto] could not polyfill:", err.message);
  }
}

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const Sentry = require("@sentry/node");
require("dotenv").config();

// Initialize Sentry if DSN is provided
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "development",
    tracesSampleRate: 0.1,
  });
  console.log("[Sentry] Initialized");
}

const authRoutes = require("./routes/auth");
const servicesRoutes = require("./routes/services");
const settingsRoutes = require("./routes/settings");
const notificationRoutes = require("./routes/notifications");
const serviceCatalogRoutes = require("./routes/serviceCatalog");
const ServiceCatalog = require("./models/serviceCatalog");
const { authenticate } = require("./middleware/auth");

// WhatsApp auto-reconnect on startup (safe-require so Railway works without Baileys)
let reconnectSavedSessions = null;
let handleIncomingMessage = null;
try {
  ({ reconnectSavedSessions } = require("./whatsapp/connection"));
  ({ handleIncomingMessage } = require("./whatsapp/handler"));
} catch (err) {
  console.warn("[WA] Could not load WhatsApp reconnect helpers:", err.message);
}

const app = express();

// Sentry request handler (must be first middleware)
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.requestHandler());
}
const PORT = process.env.PORT || 3000;

// Security: hide server identity
app.disable("x-powered-by");

// Security: helmet headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: [
          "'self'",
          "https://generativelanguage.googleapis.com",
          "https://api.minimaxi.chat",
        ],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// CORS Middleware
const allowedOrigins = [
  "https://gurusoluciones.netlify.app",
  "https://gurusolucionesrd.com",
  "https://www.gurusolucionesrd.com",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://100.87.41.106:5174",
];

app.use(
  cors({
    origin: function (origin, callback) {
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
app.use(cookieParser());

// Trust Railway/reverse proxy so express-rate-limit can use X-Forwarded-For safely
app.set('trust proxy', 1);

// Security: global rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});
app.use("/api/", globalLimiter);

// Request logging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// --- CORE ROUTES (original payroll + auth) ---
app.use("/api/auth", authRoutes);
app.use("/api/services", servicesRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/notifications", notificationRoutes);

// Compatibility alias: some dashboard builds call /api/services/categories/list
// but the catalog lives under /api/service-catalog.
app.get('/api/services/categories/list', authenticate, async (req, res) => {
  try {
    const categories = await ServiceCatalog.getCategories();
    res.json({ categories });
  } catch (err) {
    console.error('List categories error:', err);
    res.status(500).json({ error: 'Failed to list categories' });
  }
});

// --- NEW ROUTES from bot dashboard merge ---
const safeRoutes = [
  { path: "/api/admin", module: "./routes/admin" },
  { path: "/api/admin/simulator", module: "./routes/adminSimulator" },
  { path: "/api/clients", module: "./routes/clients" },
  { path: "/api/cases", module: "./routes/cases" },
  { path: "/api/dashboard", module: "./routes/dashboard" },
  { path: "/api/media", module: "./routes/media" },
  { path: "/api/invoices", module: "./routes/invoices" },
  { path: "/api/documents", module: "./routes/documents" },
  { path: "/api/docgen", module: "./routes/docGen" },
  { path: "/api/service-catalog", module: "./routes/serviceCatalog" },
];

for (const route of safeRoutes) {
  try {
    const handler = require(route.module);
    app.use(route.path, handler);
    console.log(`[Routes] Mounted ${route.path}`);
  } catch (err) {
    console.error(`[Routes] FAILED to mount ${route.path}:`, err.message);
  }
}

// --- AI ROUTE ---
try {
  const aiRoutes = require("./routes/ai");
  app.use("/api/ai", aiRoutes);
  console.log("[Routes] Mounted /api/ai");
} catch (err) {
  console.error("[Routes] Skipping /api/ai:", err.message);
}

// --- BOT SIMULATOR (dashboard test chat without WhatsApp) ---
try {
  const botSimulatorRoutes = require("./routes/botSimulator");
  app.use("/api/bot", botSimulatorRoutes);
  console.log("[Routes] Mounted /api/bot");
} catch (err) {
  console.error("[Routes] Skipping /api/bot:", err.message);
  console.error("[Routes] /api/bot stack:", err.stack);
}

// --- WHATSAPP-RELATED ROUTES (skip on Railway if Baileys missing) ---
try {
  const messageRoutes = require("./routes/messages");
  app.use("/api/messages", messageRoutes);
  console.log("[Routes] Mounted /api/messages");
} catch (err) {
  console.error("[Routes] Skipping /api/messages:", err.message);
}

try {
  const broadcastRoutes = require("./routes/broadcasts");
  app.use("/api/broadcasts", broadcastRoutes);
  console.log("[Routes] Mounted /api/broadcasts");
} catch (err) {
  console.error("[Routes] Skipping /api/broadcasts:", err.message);
}

try {
  const whatsappRoutes = require("./routes/whatsapp");
  app.use("/api/whatsapp", whatsappRoutes);
  console.log("[Routes] Mounted /api/whatsapp");
} catch (err) {
  console.error("[Routes] Skipping /api/whatsapp:", err.message);
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "Guruweb API",
    version: "2.0.0",
    endpoints: {
      auth: "/api/auth",
      services: "/api/services",
      serviceCatalog: "/api/service-catalog",
      clients: "/api/clients",
      cases: "/api/cases",
      dashboard: "/api/dashboard",
      documents: "/api/documents",
      settings: "/api/settings",
      health: "/health",
    },
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Sentry error handler (before our custom handler)
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// Global error handler — NEVER expose stack traces or internal details in production
app.use((err, req, res, next) => {
  console.error("[Error]", err);
  if (err.message === "Not allowed by CORS") {
    return res.status(403).json({ error: "Forbidden" });
  }
  const isDev = process.env.NODE_ENV === "development";
  const statusCode = err.statusCode || err.status || 500;
  const response = {
    error: err.publicMessage || "Internal server error",
  };
  if (isDev) {
    response.message = err.message;
    response.stack = err.stack;
  }
  res.status(statusCode).json(response);
});

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || "development"}`);
  console.log(`🔗 API: http://localhost:${PORT}`);
  console.log(`🏥 Health check: http://localhost:${PORT}/health`);
  console.log(`✅ CORS enabled for: ${allowedOrigins.join(", ")}`);

  // Auto-reconnect saved WhatsApp sessions (credentials live in PostgreSQL)
  if (reconnectSavedSessions) {
    reconnectSavedSessions(handleIncomingMessage).catch(err => {
      console.error('[WA] Auto-reconnect error:', err.message);
    });
  }
});

module.exports = app;
