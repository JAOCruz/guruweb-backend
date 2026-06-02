const { Pool } = require('pg');

// Support DATABASE_URL (Railway/Heroku) or individual env vars
const isProduction = process.env.NODE_ENV === 'production';

let poolConfig;
if (process.env.DATABASE_URL) {
  poolConfig = {
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  };
} else {
  poolConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'guru_legal_bot',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
    ssl: isProduction ? { rejectUnauthorized: false } : false,
  };
}

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  const url = process.env.DATABASE_URL || `${poolConfig.host}:${poolConfig.port}/${poolConfig.database}`;
  const masked = url.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');
  console.log('✅ DB connected to', masked);
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database pool error:', err);
});

module.exports = pool;
