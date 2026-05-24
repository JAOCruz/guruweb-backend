require('dotenv').config();

// Security: Require critical env vars at startup
const requireEnv = (name, allowDefault = false) => {
  const val = process.env[name];
  if (!val || (val === 'change-me-in-production' && !allowDefault)) {
    console.error(`[SECURITY] FATAL: Missing or default value for ${name}`);
    process.exit(1);
  }
  return val;
};

// Validate critical settings on startup
requireEnv('JWT_SECRET');

// Support DATABASE_URL (Railway/Heroku) without requiring individual DB_PASSWORD
if (!process.env.DATABASE_URL && !process.env.DB_PASSWORD) {
  console.error('[SECURITY] FATAL: Either DATABASE_URL or DB_PASSWORD must be set');
  process.exit(1);
}

// Warn about optional but recommended env vars
if (!process.env.GEMINI_API_KEY) {
  console.warn('[CONFIG] GEMINI_API_KEY not set — AI features will be disabled');
}

module.exports = {
  // Server config
  port: process.env.PORT || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database config
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'guru_legal_bot',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  },

  // JWT config
  jwt: {
    secret: process.env.JWT_SECRET || 'change-me-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  // WhatsApp config
  wa: {
    sessionDir: process.env.WA_SESSION_DIR || './wa_sessions',
  },

  // Uploads config
  uploads: {
    dir: process.env.UPLOADS_DIR || './uploads',
    maxSizeMB: parseInt(process.env.MAX_UPLOAD_SIZE_MB) || 25,
  },

  // Gemini AI config
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    enabled: process.env.GEMINI_ENABLED !== 'false' && !!process.env.GEMINI_API_KEY,
  },

  // MiniMax AI config (alternative to Gemini)
  minimax: {
    apiKey: process.env.MINIMAX_API_KEY || '',
    enabled: process.env.MINIMAX_ENABLED !== 'false' && !!process.env.MINIMAX_API_KEY,
  },
};
