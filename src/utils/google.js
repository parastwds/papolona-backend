const { OAuth2Client } = require('google-auth-library');
const env = require('../config/env');
const ApiError = require('./ApiError');

const client = new OAuth2Client();

/**
 * Verifies a Google ID token from the app (signature, issuer, expiry, and that it was issued
 * for our Web client ID) and returns its claims. Kept on an object so tests can replace it.
 */
const google = {
  async verifyIdToken(idToken) {
    if (!env.GOOGLE_WEB_CLIENT_ID) {
      throw new ApiError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not available right now.');
    }
    try {
      const ticket = await client.verifyIdToken({ idToken, audience: env.GOOGLE_WEB_CLIENT_ID });
      return ticket.getPayload();
    } catch {
      throw ApiError.unauthorized('GOOGLE_TOKEN_INVALID', 'Google sign-in failed. Please try again.');
    }
  },
};

module.exports = google;
