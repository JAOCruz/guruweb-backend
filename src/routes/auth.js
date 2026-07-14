const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const config = require('../config');
const { generateToken, authenticate } = require('../middleware/auth');

const router = express.Router();

// Cookie options for cross-origin (Netlify frontend ↔ Railway backend)
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;     // 24 hours
const REMEMBER_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

function cookieOptions(rememberMe = false) {
  return {
    httpOnly: true,
    secure: isProduction,           // Only send over HTTPS in production
    sameSite: isProduction ? 'none' : 'lax', // 'none' required for cross-origin cookies
    maxAge: rememberMe ? REMEMBER_MAX_AGE : SESSION_MAX_AGE,
    path: '/',
  };
}

// IPv6-safe key generator (use last 3 segments)
const ipKeyGenerator = (req) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  if (ip.includes(':')) {
    return ip.split(':').slice(-3).join(':');
  }
  return ip;
};

// Rate limiters
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  keyGenerator: ipKeyGenerator,
  message: 'Too many registration attempts, try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  keyGenerator: (req) => ipKeyGenerator(req) + ':' + (req.body.email || req.body.username || 'unknown'),
  message: 'Too many login attempts, try again later',
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/register', registerLimiter, async (req, res) => {
  try {
    const { email, password, name, username, role, data_column } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'email, password, and name are required' });
    }

    const existing = await User.findByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const user = await User.create({ email, password, name, role: role || 'digitador', username, data_column });
    const token = generateToken(user);
    res.status(201).json({ user, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, username, password, rememberMe } = req.body;
    const identifier = email || username;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'email/username and password are required' });
    }

    const user = await User.findByUsernameOrEmail(identifier);
    if (!user) {
      console.log('[login] User not found for identifier:', identifier);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await User.verifyPassword(password, user.password_hash);
    if (!valid) {
      console.log('[login] Password mismatch for user:', user.username, 'hash starts with:', user.password_hash?.slice(0, 10));
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const tokenExpiresIn = rememberMe ? '30d' : config.jwt.expiresIn;
    const token = generateToken({
      ...user,
      email: user.email || user.username,
      name: user.name || user.username,
    }, tokenExpiresIn);

    // Set HttpOnly cookie (primary auth method — prevents XSS theft)
    res.cookie('access_token', token, cookieOptions(rememberMe));

    res.json({
      user: {
        id: user.id,
        username: user.username || user.email,
        email: user.email || user.username,
        name: user.name || user.username,
        role: user.role,
        dataColumn: user.data_column,
      },
      token, // Kept for backward-compat during transition; frontend should ignore
      rememberMe: !!rememberMe,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      user: {
        id: user.id,
        username: user.username || user.email,
        email: user.email || user.username,
        name: user.name || user.username,
        role: user.role,
        dataColumn: user.data_column,
      },
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Keepalive ping
router.post('/ping', authenticate, (req, res) => {
  res.json({ ok: true, userId: req.user.id });
});

// Logout — clear the HttpOnly cookie and invalidate session on client
router.post('/logout', authenticate, (req, res) => {
  res.clearCookie('access_token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? 'none' : 'lax',
    path: '/',
  });
  res.json({ ok: true, message: 'Logged out successfully' });
});

module.exports = router;
