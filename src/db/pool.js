const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool(config.db);

pool.on('error', (err) => {
  console.error('Unexpected database pool error:', err);
});

module.exports = pool;
