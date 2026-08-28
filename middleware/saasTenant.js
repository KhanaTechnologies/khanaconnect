const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');

function resolveBearer(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return '';
  return auth.slice(7).trim();
}

function tenantResolver(req, res, next) {
  try {
    const token = resolveBearer(req);
    let claims = {};
    if (token) {
      const { decoded } = verifyJwtWithAnySecret(jwt, token);
      claims = decoded;
    }

    const headerClientId = String(req.headers['x-client-id'] || '').trim();
    const bodyClientId = String(req.body?.client_id || '').trim();
    const tokenClientId = String(
      claims.clientID || claims.client_id || claims.clientId || ''
    ).trim();
    // Never let a purpose/state JWT pick tenant from headers (OAuth state is not a session).
    const clientId = tokenClientId || (claims.purpose ? '' : headerClientId || bodyClientId);

    if (!clientId) {
      return res.status(400).json({ ok: false, message: 'Missing tenant context (client_id)' });
    }

    if (headerClientId && tokenClientId && headerClientId !== tokenClientId) {
      return res.status(403).json({ ok: false, message: 'Tenant mismatch' });
    }

    let inferredRole = 'user';
    const orgRole = String(claims.orgRole || '').toLowerCase();
    if (claims.customerID || claims.loginType === 'customer' || claims.buyerId || claims.role === 'b2b') {
      inferredRole = 'user';
    } else if (claims.purpose) {
      inferredRole = 'user';
    } else if (claims.loginType === 'platform_admin') {
      // Khana platform tenant (client.role admin) signing in without a team member row.
      inferredRole = 'owner';
    } else if (orgRole === 'admin') {
      inferredRole = 'owner';
    } else if (orgRole) {
      inferredRole = orgRole;
    } else if (claims.loginType === 'team' || claims.memberId) {
      inferredRole = 'member';
    }

    req.tenant = {
      clientId,
      role: inferredRole,
      userId: claims.userId || claims.id || claims.memberId || '',
    };
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, message: 'Unauthorized tenant context', error: e.message });
  }
}

/**
 * Platform admin gate. JWTs historically omit `role`, so we also check Client.role in DB
 * (same pattern as middleware/requireAdmin.js).
 */
async function adminOnly(req, res, next) {
  try {
    const role = String(req.tenant?.role || '').toLowerCase();
    const adminApiKey = process.env.SAAS_ADMIN_API_KEY || '';
    const incomingApiKey = String(req.headers['x-admin-api-key'] || '');
    if (role === 'admin' || (adminApiKey && incomingApiKey === adminApiKey)) {
      return next();
    }

    const clientId = String(req.tenant?.clientId || '').trim();
    if (clientId) {
      const client = await Client.findOne({ clientID: clientId }).select('role').lean();
      if (client?.role === 'admin') {
        req.tenant.role = 'admin';
        return next();
      }
    }

    return res.status(403).json({ ok: false, message: 'Admin access required' });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Admin check failed', error: e.message });
  }
}

function requireRoles(...allowed) {
  const normalizedAllowed = allowed.map((r) => String(r).toLowerCase());
  return function (req, res, next) {
    const role = String(req.tenant?.role || 'user').toLowerCase();
    if (normalizedAllowed.includes(role)) return next();
    return res.status(403).json({
      ok: false,
      message: `Role ${role} is not allowed. Required one of: ${normalizedAllowed.join(', ')}`,
    });
  };
}

module.exports = { tenantResolver, adminOnly, requireRoles };
