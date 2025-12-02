const jwt = require('jsonwebtoken');
const User = require('../models/User');
const RefreshToken = require('../models/RefreshToken');

const authController = {
  async login(req, res) {
    try {
      const { username, password } = req.body;

      if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }

      const user = await User.findByUsername(username);
      if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      const isValidPassword = await User.verifyPassword(password, user.password_hash);
      if (!isValidPassword) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }

      // Generate access token (short-lived)
      const accessToken = jwt.sign(
        {
          id: user.id,
          username: user.username,
          role: user.role,
          dataColumn: user.data_column
        },
        process.env.JWT_SECRET || 'your_jwt_secret_change_me',
        { expiresIn: process.env.JWT_EXPIRES_IN || '15m' } // Shorter expiration for access token
      );

      // Generate refresh token (long-lived)
      const refreshToken = await RefreshToken.create(user.id, 30); // 30 days

      res.json({
        token: accessToken,
        refreshToken,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          dataColumn: user.data_column
        }
      });
    } catch (error) {
      console.error('Login error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  async refresh(req, res) {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({ error: 'Refresh token is required' });
      }

      // Verify refresh token exists and is valid
      const tokenData = await RefreshToken.findByToken(refreshToken);
      if (!tokenData) {
        return res.status(401).json({ error: 'Invalid or expired refresh token' });
      }

      // Get user data
      const user = await User.findById(tokenData.user_id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Generate new access token
      const accessToken = jwt.sign(
        {
          id: user.id,
          username: user.username,
          role: user.role,
          dataColumn: user.data_column
        },
        process.env.JWT_SECRET || 'your_jwt_secret_change_me',
        { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
      );

      // Optionally rotate refresh token (more secure)
      await RefreshToken.revoke(refreshToken);
      const newRefreshToken = await RefreshToken.create(user.id, 30);

      res.json({
        token: accessToken,
        refreshToken: newRefreshToken
      });
    } catch (error) {
      console.error('Refresh token error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  async logout(req, res) {
    try {
      const { refreshToken } = req.body;

      if (refreshToken) {
        await RefreshToken.revoke(refreshToken);
      }

      res.json({ message: 'Logged out successfully' });
    } catch (error) {
      console.error('Logout error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },

  async getCurrentUser(req, res) {
    try {
      const user = await User.findById(req.user.id);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({
        id: user.id,
        username: user.username,
        role: user.role,
        dataColumn: user.data_column
      });
    } catch (error) {
      console.error('Get current user error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
};

module.exports = authController;
