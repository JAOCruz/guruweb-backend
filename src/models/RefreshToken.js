const pool = require('../config/database');
const crypto = require('crypto');

class RefreshToken {
  /**
   * Generate a secure random refresh token
   */
  static generateToken() {
    return crypto.randomBytes(64).toString('hex');
  }

  /**
   * Create a new refresh token for a user
   * @param {number} userId - User ID
   * @param {number} expiresInDays - Token expiration in days (default: 30)
   * @returns {Promise<string>} - The generated refresh token
   */
  static async create(userId, expiresInDays = 30) {
    const token = this.generateToken();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [userId, token, expiresAt]
    );

    return token;
  }

  /**
   * Find a refresh token by token string
   * @param {string} token - Refresh token
   * @returns {Promise<Object|null>} - Token data or null
   */
  static async findByToken(token) {
    const result = await pool.query(
      'SELECT * FROM refresh_tokens WHERE token = $1 AND revoked = FALSE AND expires_at > NOW()',
      [token]
    );
    return result.rows[0] || null;
  }

  /**
   * Revoke a refresh token
   * @param {string} token - Refresh token to revoke
   */
  static async revoke(token) {
    await pool.query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE token = $1',
      [token]
    );
  }

  /**
   * Revoke all refresh tokens for a user
   * @param {number} userId - User ID
   */
  static async revokeAllForUser(userId) {
    await pool.query(
      'UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1',
      [userId]
    );
  }

  /**
   * Delete expired and revoked tokens (cleanup)
   */
  static async cleanup() {
    await pool.query(
      'DELETE FROM refresh_tokens WHERE expires_at < NOW() OR revoked = TRUE'
    );
  }
}

module.exports = RefreshToken;
