const jwt = require('jsonwebtoken');
const config = require('../config');
const pool = require('../db/pool');

// Throttle last_seen DB writes — at most once per 60s per user
const lastSeenThrottle = new Map(); // userId → timestamp

// Per-user status cache so a deactivated user is cut off within STATUS_TTL_MS
const STATUS_TTL_MS = 60_000;
const statusCache = new Map(); // userId → { status, at }

// Endpoints still reachable while a temporary password must be replaced
const PASSWORD_CHANGE_ALLOWED = [
  ['GET', '/api/auth/me'],
  ['PUT', '/api/auth/change-password'],
  ['POST', '/api/auth/logout'],
];

async function getUserStatus(id) {
  const hit = statusCache.get(id);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
  let status = { is_active: true, must_change_password: false };
  try {
    const { rows } = await pool.query('SELECT is_active, must_change_password, role FROM users WHERE id = $1', [id]);
    status = rows[0]
      ? { is_active: rows[0].is_active !== false, must_change_password: rows[0].must_change_password === true, role: rows[0].role }
      : { is_active: false, must_change_password: false };
  } catch (err) {
    // 42703 = column missing (user-management migration not run yet): treat as active
    if (err.code !== '42703') throw err;
  }
  statusCache.set(id, { status, at: Date.now() });
  return status;
}

function invalidateUserStatus(id) {
  statusCache.delete(Number(id));
}

async function authenticate(req, res, next) {
  // During transition: prefer Authorization header (localStorage fallback),
  // then HttpOnly cookie. This prevents stale/invalid cookies from blocking
  // valid tokens stored in localStorage.
  let token = null;
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  }
  if (!token) {
    token = req.cookies?.access_token;
  }

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = { id: payload.id, email: payload.email, username: payload.username, role: payload.role };
  req.auth = { iat: payload.iat, exp: payload.exp, rm: payload.rm };

  let status;
  try {
    status = await getUserStatus(payload.id);
  } catch (err) {
    console.error('[auth] status lookup failed:', err.message);
    return res.status(503).json({ error: 'Servicio no disponible, intenta de nuevo' });
  }
  // The DB role wins over the token's, so a demotion takes effect right away
  if (status.role) req.user.role = status.role;
  if (!status.is_active) {
    return res.status(401).json({ error: 'Usuario desactivado. Contacta al administrador.', code: 'USER_INACTIVE' });
  }
  if (status.must_change_password) {
    const path = (req.originalUrl || '').split('?')[0];
    const allowed = PASSWORD_CHANGE_ALLOWED.some(([m, p]) => m === req.method && path === p);
    if (!allowed) {
      return res.status(403).json({ error: 'Debes cambiar tu contraseña para continuar', code: 'PASSWORD_CHANGE_REQUIRED' });
    }
  }

  // Update last_seen (throttled — max 1 write per 60s per user)
  const now = Date.now();
  const last = lastSeenThrottle.get(payload.id) || 0;
  if (now - last > 60_000) {
    lastSeenThrottle.set(payload.id, now);
    pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [payload.id])
      .catch(err => console.error('[auth] last_seen update failed:', err.message));
  }

  next();
}

function generateToken(user, expiresIn = config.jwt.expiresIn, extra = {}) {
  return jwt.sign(
    { id: user.id, email: user.email, username: user.username, role: user.role, ...extra },
    config.jwt.secret,
    { expiresIn, algorithm: 'HS256' }
  );
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Backward-compatible aliases for original production routes
const authMiddleware = authenticate;
const isAdmin = requireRole('admin');

module.exports = { authenticate, generateToken, requireRole, authMiddleware, isAdmin, getUserStatus, invalidateUserStatus };
