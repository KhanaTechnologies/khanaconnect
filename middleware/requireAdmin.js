const jwt = require('jsonwebtoken');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { resolveSessionFromToken } = require('../helpers/teamAuth');

/**
 * True only for a real Khana platform-admin dashboard session:
 *  - password-only platform login (loginType 'platform_admin') on the admin client, or
 *  - a team session of the admin client's owner.
 * Storefront API tokens, shopper / B2B tokens and OAuth state tokens of the admin
 * client share its clientID, so checking Client.role alone is not enough.
 * Mirrors platformAdminSession in helpers/teamLogin.js (what the dashboard shows as admin).
 * @returns {Promise<import('mongoose').Document|null>} the admin client, or null
 */
async function resolvePlatformAdmin(decoded) {
  if (!decoded?.clientID) return null;
  if (decoded.customerID || decoded.buyerId || decoded.purpose) return null;

  const session = await resolveSessionFromToken(decoded);
  if (!session || session.client.role !== 'admin') return null;

  if (session.platformAdmin) return session.client; // owner team member
  if (!session.member && decoded.loginType === 'platform_admin') return session.client;
  return null;
}

/**
 * Verifies Bearer JWT and ensures it is a platform-admin session (see resolvePlatformAdmin).
 * Attaches req.user (decoded JWT) and req.adminClient (lean client summary).
 */
async function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = auth.split(' ')[1];
    const { decoded } = verifyJwtWithAnySecret(jwt, token);
    const client = await resolvePlatformAdmin(decoded);
    if (!client) {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    req.user = decoded;
    req.adminClient = {
      clientID: client.clientID,
      companyName: client.companyName,
      role: client.role,
    };
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

module.exports = { requireAdmin, resolvePlatformAdmin };
