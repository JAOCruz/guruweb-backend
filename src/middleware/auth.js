const jwt = require('jsonwebtoken');
const config = require('../config');
const pool = require('../db/pool');

// Throttle last_seen DB writes — at most once per 60s per user
const lastSeenThrottle = new Map(); // userId → timestamp

function authenticate(req, res, next) {
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
  try {
    const payload = jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'] });
    req.user = { id: payload.id, email: payload.email, username: payload.username, role: payload.role };

    // Update last_seen (throttled — max 1 write per 60s per user)
    const now = Date.now();
    const last = lastSeenThrottle.get(payload.id) || 0;
    if (now - last > 60_000) {
      lastSeenThrottle.set(payload.id, now);
      pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [payload.id])
        .catch(err => console.error('[auth] last_seen update failed:', err.message));
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, username: user.username, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn, algorithm: 'HS256' }
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

module.exports = { authenticate, generateToken, requireRole, authMiddleware, isAdmin };
