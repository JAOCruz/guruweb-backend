// Sitios que pueden usar la API con sesión: la lista fija más los de ALLOWED_ORIGINS (separados por coma),
// p. ej. el dashboard del backend de prueba.
const FIXED = [
  "https://gurusoluciones.netlify.app",
  "https://guruweb-dashboard-prod.netlify.app",
  "https://guruweb-development.netlify.app",
  "https://papaya-kangaroo-b789f3.netlify.app",
  "https://6ab57be44eee966f948b918d--papaya-kangaroo-b789f3.netlify.app",
  "https://gurusolucionesrd.com",
  "https://www.gurusolucionesrd.com",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://100.87.41.106:5174",
];

function allowedOrigins(env = process.env) {
  const extra = String(env.ALLOWED_ORIGINS || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  return [...new Set([...FIXED, ...extra])];
}

module.exports = { allowedOrigins };
