const jwt = require('jsonwebtoken');
const { verifyJwtWithAnySecret } = require('./jwtSecret');
const { resolveSessionFromToken } = require('./teamAuth');

/**
 * Dashboard API auth + team member permission enforcement.
 * @param {string|null} moduleKey - e.g. 'products', 'orders'. null = dashboard access only.
 */
function createDashboardAuth(moduleKey = null) {
  return async function dashboardAuthMiddleware(req, res, next) {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
      }

      const tokenValue = authHeader.split(' ')[1];
      const { decoded } = verifyJwtWithAnySecret(jwt, tokenValue);
      if (!decoded?.clientID) {
        return res.status(403).json({ error: 'Forbidden - Invalid token' });
      }

      const session = await resolveSessionFromToken(decoded);
      if (!session) {
        return res.status(401).json({ error: 'Invalid or expired session. Please sign in again.' });
      }

      req.user = decoded;
      req.teamSession = session;
      req.clientId = session.client.clientID;
      req.clientID = session.client.clientID;

      if (session.platformAdmin) {
        return next();
      }

      const permissions = session.permissions || {};

      if (!session.member) {
        if (session.isApiToken) {
          if (moduleKey && !permissions[moduleKey]) {
            return res.status(403).json({ error: `You do not have permission to access ${moduleKey}` });
          }
          return next();
        }

        return res.status(403).json({
          error: 'Team member sign-in required. Please log out and sign in with your email and password.',
        });
      }

      if (!permissions.dashboard) {
        return res.status(403).json({ error: 'Dashboard access denied' });
      }

      if (moduleKey && !permissions[moduleKey]) {
        return res.status(403).json({ error: `You do not have permission to access ${moduleKey}` });
      }

      return next();
    } catch (_err) {
      return res.status(403).json({ error: 'Forbidden - Invalid token' });
    }
  };
}

module.exports = {
  createDashboardAuth,
};
