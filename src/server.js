const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const config = require('./config');
const { reconnectSavedSessions } = require('./whatsapp/connection');
const { handleIncomingMessage } = require('./whatsapp/handler');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const clientRoutes = require('./routes/clients');
const caseRoutes = require('./routes/cases');
const messageRoutes = require('./routes/messages');
const whatsappRoutes = require('./routes/whatsapp');
const dashboardRoutes = require('./routes/dashboard');
const mediaRoutes = require('./routes/media');
const invoiceRoutes = require('./routes/invoices');
const broadcastRoutes = require('./routes/broadcasts');
const { sendBroadcast } = require('./routes/broadcasts');
const serviceCatalogRoutes = require('./routes/serviceCatalog');
const employeeServiceRoutes = require('./routes/employeeServices');
const settingsRoutes = require('./routes/settings');
const documentRoutes = require('./routes/documents');
const docGenRoutes = require('./routes/docGen');

const app = express();

// Security: hide server identity
app.disable('x-powered-by');

// Security: helmet headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc: ["'self'", "https://generativelanguage.googleapis.com", "https://api.minimaxi.chat"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Security: restrict CORS to known origins
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
  : [
      'http://localhost:5174', 'http://127.0.0.1:5174', 'http://100.87.41.106:5174',
      'https://gurusolucionesrd.com', 'https://www.gurusolucionesrd.com',
      'https://gurusoluciones.netlify.app',
    ];
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));

app.use(express.json());

// Trust Railway/reverse proxy so express-rate-limit can use X-Forwarded-For safely
app.set('trust proxy', 1);

// Security: global rate limiting
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', globalLimiter);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/cases', caseRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/whatsapp', whatsappRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/invoices', invoiceRoutes);
app.use('/api/broadcasts', broadcastRoutes);
app.use('/api/services', employeeServiceRoutes);
app.use('/api/service-catalog', serviceCatalogRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/docgen', docGenRoutes);

// Scheduler: check every 60s for scheduled broadcasts due to send
setInterval(async () => {
  try {
    const Broadcast = require('./models/Broadcast');
    const pending = await Broadcast.getPendingScheduled();
    for (const b of pending) {
      console.log(`[Scheduler] Sending scheduled broadcast #${b.id}`);
      sendBroadcast(b.id).catch(err => console.error('[Scheduler] Error:', err.message));
    }
  } catch (err) {
    console.error('[Scheduler] Check error:', err.message);
  }
}, 60000);

// Error handler (API only, frontend on separate port 5174)
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  // CORS errors should return 403, not 500
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  // Don't leak internal error details in production
  const message = config.nodeEnv === 'production'
    ? 'Internal server error'
    : (err.message || 'Internal server error');
  res.status(500).json({ error: message });
});

// Railway (and most container platforms) require 0.0.0.0
const host = process.env.BIND_HOST || '0.0.0.0';
app.listen(config.port, host, () => {
  console.log(`Server running on http://${host}:${config.port} [${config.nodeEnv}]`);

  // Auto-reconnect saved WhatsApp sessions
  reconnectSavedSessions(handleIncomingMessage).catch(err => {
    console.error('[WA] Auto-reconnect error:', err.message);
  });
});
