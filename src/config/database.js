const { Pool } = require("pg");
require("dotenv").config();

const isProduction = process.env.NODE_ENV === "production";

// Objeto de configuración base
let poolConfig = {
  ssl: isProduction ? { rejectUnauthorized: false } : false,
};

// Lógica HÍBRIDA:
// 1. Si existe DATABASE_URL (común en Railway/Heroku), úsala.
if (process.env.DATABASE_URL) {
  poolConfig.connectionString = process.env.DATABASE_URL;
}
// 2. Si no, usa las variables individuales (Docker/Local)
else {
  poolConfig.user = process.env.DB_USER;
  poolConfig.host = process.env.DB_HOST;
  poolConfig.database = process.env.DB_NAME;
  poolConfig.password = process.env.DB_PASSWORD;
  poolConfig.port = process.env.DB_PORT;
}

const pool = new Pool(poolConfig);

pool.on("connect", () => {
  // Solo logueamos el host para no exponer contraseñas
  console.log(
    "✅ Connected to DB. Host:",
    process.env.DATABASE_URL ? "External URL" : process.env.DB_HOST,
  );
});

pool.on("error", (err) => {
  console.error("❌ Unexpected error on idle client", err);
  process.exit(-1);
});

module.exports = pool;
