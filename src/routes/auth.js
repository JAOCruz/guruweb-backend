const express = require('express');
const rateLimit = require('express-rate-limit');
const User = require('../models/User');
const { generateToken, authenticate } = require('../middleware/auth');

const router = express.Router();

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

    const user = await User.create({ email, password, name, role: role || 'lawyer', username, data_column });
    const token = generateToken(user);
    res.status(201).json({ user, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const identifier = email || username;

    if (!identifier || !password) {
      return res.status(400).json({ error: 'email/username and password are required' });
    }

    const user = await User.findByUsernameOrEmail(identifier);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await User.verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);
    res.json({
      user: {
        id: user.id,
        username: user.username || user.email,
        email: user.email,
        name: user.name,
        role: user.role,
        dataColumn: user.data_column,
      },
      token,
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
        email: user.email,
        name: user.name,
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

module.exports = router;
