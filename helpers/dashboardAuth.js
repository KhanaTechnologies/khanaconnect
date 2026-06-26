const jwt = require('jsonwebtoken');
const { verifyJwtWithAnySecret } = require('./jwtSecret');
const { resolveSessionFromToken } = require('./teamAuth');
const {
  isClientSubscriptionActive,
  subscriptionBlockedResponse,
} = require('./clientSubscription');

/**
 * Dashboard API auth + team member permission enforcement.
 * @param {string|string[]|null} moduleKey - one key, or any-of list (e.g. ['newsletter','email_center'])
 */
function createDashboardAuth(moduleKey = null) {
  const moduleKeys = moduleKey == null
    ? []
    : Array.isArray(moduleKey)
      ? moduleKey
      : [moduleKey];

  function hasModuleAccess(permissions) {
    if (!moduleKeys.length) return true;
    return moduleKeys.some((key) => !!permissions[key]);
  }

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

      if (!isClientSubscriptionActive(session.client)) {
        return subscriptionBlockedResponse(res, session.client);
      }

      const permissions = session.permissions || {};

      if (!session.member) {
        if (session.isApiToken) {
          if (moduleKeys.length && !hasModuleAccess(permissions)) {
            return res.status(403).json({
              error: `You do not have permission to access ${moduleKeys.join(' or ')}`,
            });
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

      if (moduleKeys.length && !hasModuleAccess(permissions)) {
        return res.status(403).json({
          error: `You do not have permission to access ${moduleKeys.join(' or ')}`,
        });
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
