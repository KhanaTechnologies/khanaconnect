const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { resolveSessionFromToken } = require('../helpers/teamAuth');

/**
 * Requires a valid Bearer JWT for the same clientID as :clientId (or :id),
 * or a platform admin. Attaches req.user and optionally req.teamSession.
 */
function requireSelfOrAdmin(paramName = 'clientId') {
  return async function requireSelfOrAdminMiddleware(req, res, next) {
    try {
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
      }

      const token = auth.split(' ')[1];
      const { decoded } = verifyJwtWithAnySecret(jwt, token);
      if (!decoded?.clientID) {
        return res.status(403).json({ success: false, error: 'Forbidden - Invalid token' });
      }

      const targetClientId = String(req.params[paramName] || '').trim();
      if (!targetClientId) {
        return res.status(400).json({ success: false, error: 'Client ID required' });
      }

      const client = await Client.findOne({ clientID: decoded.clientID }).select(
        'clientID companyName role'
      );
      if (!client) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session' });
      }

      const isAdmin = client.role === 'admin';
      if (!isAdmin && decoded.clientID !== targetClientId) {
        return res.status(403).json({
          success: false,
          error: 'You can only access your own organization',
        });
      }

      req.user = decoded;
      req.clientID = decoded.clientID;
      req.isPlatformAdmin = isAdmin;

      try {
        req.teamSession = await resolveSessionFromToken(decoded);
      } catch (_err) {
        req.teamSession = null;
      }

      return next();
    } catch (_err) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
  };
}

module.exports = { requireSelfOrAdmin };
