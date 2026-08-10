const jwt = require('jsonwebtoken');
const { verifyJwtWithAnySecret } = require('./jwtSecret');
const { resolveSessionFromToken } = require('./teamAuth');

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Paths view-only reviewers may still call (Meta App Review demos + own password). */
const READONLY_WRITE_ALLOW = [
  /^\/saas\/whatsapp\/conversions\/test-event\/?$/i,
  /^\/saas\/meta\/pixel\/test-event\/?$/i,
  /^\/saas\/meta\/oauth\/complete\/?$/i,
  /^\/saas\/meta\/refresh-token\/?$/i,
  /^\/saas\/ads\/accounts\/?$/i,
  /^\/saas\/whatsapp\/accounts\/?$/i,
  /^\/saas\/whatsapp\/conversions\/dataset\/?$/i,
  /^\/saas\/meta\/catalog\/sync\/?$/i,
  /^\/saas\/whatsapp\/templates\/sync\/?$/i,
  /^\/team\/me\/password\/?$/i,
  /^\/team\/me\/login-email\/?$/i,
];

/** Always blocked for view-only, even if a broader allow matched. */
const READONLY_WRITE_DENY = [
  /disconnect/i,
  /decommission/i,
];

function isWriteMethod(method) {
  return WRITE_METHODS.has(String(method || '').toUpperCase());
}

function requestPath(req) {
  const raw = String(req.originalUrl || req.url || '');
  return raw.split('?')[0];
}

function isReadOnlyWriteAllowed(req) {
  const path = requestPath(req);
  if (READONLY_WRITE_DENY.some((re) => re.test(path))) return false;
  if (String(req.method || '').toUpperCase() === 'DELETE') return false;
  return READONLY_WRITE_ALLOW.some((re) => re.test(path));
}

function readOnlyBlockedResponse(res) {
  return res.status(403).json({
    error: 'This account is view-only. Create, Edit, and Delete are not allowed.',
    code: 'READ_ONLY',
    ok: false,
    message: 'This account is view-only. Create, Edit, and Delete are not allowed.',
  });
}

/**
 * Enforce read-only for team members flagged permissions.readOnly.
 * Safe methods always pass. Platform admins always pass.
 */
async function enforceReadOnlyWrites(req, res, next) {
  if (!isWriteMethod(req.method)) return next();

  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return next();

    const token = auth.slice(7).trim();
    const { decoded } = verifyJwtWithAnySecret(jwt, token);
    if (!decoded?.memberId) return next();

    const session =
      req.teamSession ||
      (await resolveSessionFromToken(decoded));

    if (!session || session.platformAdmin) return next();
    if (!session.permissions?.readOnly) return next();
    if (isReadOnlyWriteAllowed(req)) return next();

    return readOnlyBlockedResponse(res);
  } catch (_err) {
    return next();
  }
}

module.exports = {
  WRITE_METHODS,
  isWriteMethod,
  isReadOnlyWriteAllowed,
  readOnlyBlockedResponse,
  enforceReadOnlyWrites,
};
