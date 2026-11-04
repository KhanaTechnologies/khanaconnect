/**
 * Dashboard session in an HttpOnly cookie instead of browser storage.
 *
 * Only for logins that arrive on the API's own subdomain (SESSION_COOKIE_HOST,
 * default api.khanatechnologies.co.za): the dashboard on khanatechnologies.co.za is then
 * same-site, so a SameSite=Lax cookie is sent with its requests and JavaScript never
 * holds the token. Logins via khanaconnect.onrender.com keep returning the token as before.
 *
 * In cookie mode the login response carries SESSION_PLACEHOLDER as `token`; the dashboard
 * keeps sending `Authorization: Bearer cookie-session`, and sessionCookieAuth swaps in
 * the real token from the cookie, so every existing auth middleware works unchanged.
 */

const SESSION_COOKIE = 'kc_session';
const SESSION_PLACEHOLDER = 'cookie-session';

function sessionCookieHost() {
  return String(process.env.SESSION_COOKIE_HOST || 'api.khanatechnologies.co.za').trim().toLowerCase();
}

function canUseSessionCookie(req) {
  return String(req.hostname || '').toLowerCase() === sessionCookieHost();
}

function setSessionCookie(res, token, expiresAtMs) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.max(expiresAtMs - Date.now(), 0),
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
}

/**
 * Use the session cookie as the bearer token when the request has no token (or the
 * placeholder). Only for whitelisted origins (or none, e.g. a top-level navigation) as a
 * CSRF guard on top of SameSite=Lax. Mount after cookie-parser, before any auth.
 */
function sessionCookieAuth(allowedOrigins) {
  return function sessionCookieAuthMiddleware(req, _res, next) {
    const cookieToken = req.cookies && req.cookies[SESSION_COOKIE];
    if (!cookieToken) return next();

    const header = String(req.headers.authorization || '');
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (bearer && bearer !== SESSION_PLACEHOLDER) return next(); // explicit token wins

    const origin = req.headers.origin;
    if (origin && !allowedOrigins.includes(origin)) return next();

    req.headers.authorization = `Bearer ${cookieToken}`;
    req.sessionFromCookie = true;
    return next();
  };
}

module.exports = {
  SESSION_COOKIE,
  SESSION_PLACEHOLDER,
  canUseSessionCookie,
  setSessionCookie,
  clearSessionCookie,
  sessionCookieAuth,
};
