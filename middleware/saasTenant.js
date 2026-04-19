const jwt = require('jsonwebtoken');
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
    const tokenClientId = String(claims.clientID || claims.client_id || '').trim();
    const clientId = tokenClientId || headerClientId || bodyClientId;

    if (!clientId) {
      return res.status(400).json({ ok: false, message: 'Missing tenant context (client_id)' });
    }

    if (headerClientId && tokenClientId && headerClientId !== tokenClientId) {
      return res.status(403).json({ ok: false, message: 'Tenant mismatch' });
    }

    const inferredRole = String(
      claims.role ||
        claims.userRole ||
        claims.user_role ||
        claims.accountRole ||
        claims.account_role ||
        (claims.isAdmin === true ? 'admin' : '') ||
        (claims.isOwner === true ? 'owner' : '') ||
        // Existing client JWTs in this codebase often carry only clientID.
        // For tenant-scoped SaaS operations, treat them as tenant owners by default.
        (tokenClientId ? 'owner' : 'user')
    ).toLowerCase();

    req.tenant = {
      clientId,
      role: inferredRole,
      userId: claims.userId || claims.id || '',
    };
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, message: 'Unauthorized tenant context', error: e.message });
  }
}

function adminOnly(req, res, next) {
  const role = String(req.tenant?.role || '').toLowerCase();
  const adminApiKey = process.env.SAAS_ADMIN_API_KEY || '';
  const incomingApiKey = String(req.headers['x-admin-api-key'] || '');
  if (role === 'admin' || (adminApiKey && incomingApiKey === adminApiKey)) {
    return next();
  }
  return res.status(403).json({ ok: false, message: 'Admin access required' });
}

function requireRoles(...allowed) {
  const normalizedAllowed = allowed.map((r) => String(r).toLowerCase());
  return function (req, res, next) {
    const role = String(req.tenant?.role || 'user').toLowerCase();
    if (role === 'admin') return next();
    if (!normalizedAllowed.includes(role)) {
      return res.status(403).json({
        ok: false,
        message: `Role ${role} is not allowed. Required one of: ${normalizedAllowed.join(', ')}`,
      });
    }
    return next();
  };
}

module.exports = { tenantResolver, adminOnly, requireRoles };
