const jwt = require('jsonwebtoken');
const { unless } = require('express-unless');
const { verifyJwtWithAnySecret } = require('./jwtSecret');

/**
 * Global JWT gate for /api/v1.
 * Only truly public paths are exempt. Everything else must present a valid Bearer JWT;
 * route-level middleware still enforces tenant ownership / admin / storefront rules.
 *
 * Verifies with any configured secret (JWT_SECRET / ENCRYPTION_KEY / secret) so
 * storefront customer tokens keep working across secret rotation.
 */
const authJwt = () => {
  const api = process.env.API_URL || '/api/v1';
  const apiEsc = api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const middleware = function authJwtMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !String(header).startsWith('Bearer ')) {
      const err = new Error('No authorization token was found');
      err.name = 'UnauthorizedError';
      err.status = 401;
      err.statusCode = 401;
      return next(err);
    }

    const tokenValue = String(header).slice(7).trim();
    if (!tokenValue) {
      const err = new Error('No authorization token was found');
      err.name = 'UnauthorizedError';
      err.status = 401;
      err.statusCode = 401;
      return next(err);
    }

    try {
      const { decoded } = verifyJwtWithAnySecret(jwt, tokenValue);
      if (
        Object.prototype.hasOwnProperty.call(decoded, 'isActive') &&
        !decoded.isActive
      ) {
        const err = new Error('Token revoked');
        err.name = 'UnauthorizedError';
        err.status = 401;
        err.statusCode = 401;
        return next(err);
      }
      // Match express-jwt shape used elsewhere
      req.auth = decoded;
      return next();
    } catch (e) {
      const err = new Error(e.message || 'Invalid token');
      err.name = 'UnauthorizedError';
      err.status = 401;
      err.statusCode = 401;
      return next(err);
    }
  };

  middleware.unless = unless;

  return middleware.unless({
    path: [
      // Static uploads
      { url: /\/public\/uploads(.*)/, methods: ['GET', 'OPTIONS'] },
      { url: /^\/uploads(\/.*)?$/, methods: ['GET', 'HEAD', 'OPTIONS'] },

      // Auth / registration / password flows
      `${api}/users/login`,
      `${api}/users/register`,
      `${api}/customer/login`,
      `${api}/customer/register`,
      `${api}/customer/registration`,
      `${api}/customer/reset-password`,
      { url: new RegExp(`^${apiEsc}/customer/reset-password(/.*)?$`), methods: ['POST', 'GET', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/customer/verify(/.*)?$`), methods: ['GET', 'POST', 'OPTIONS'] },
      `${api}/client/login`,
      `${api}/client/register`,
      { url: new RegExp(`^${apiEsc}/team/reset-password(/.*)?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/team/accept-invite(/.*)?$`), methods: ['GET', 'POST', 'OPTIONS'] },

      // Public client storefront helpers (no secrets)
      { url: new RegExp(`^${apiEsc}/client/[^/]+/whatsapp/?$`), methods: ['GET', 'OPTIONS'] },
      // Unauthenticated GET /client/:id returns public fields only (handled in route)
      { url: new RegExp(`^${apiEsc}/client/[^/]+/?$`), methods: ['GET', 'OPTIONS'] },
      // Customer booking manage links (token in body)
      { url: new RegExp(`^${apiEsc}/bookings/manage/(cancel|reschedule)/?$`), methods: ['POST', 'OPTIONS'] },

      // Public email / newsletter
      { url: /\/api\/v1\/emailsub\/(subscribe|unsubscribe)\/?$/, methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/subscribe/?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/unsubscribe/?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/contact/?$`), methods: ['POST', 'OPTIONS'] },
      { url: /\/api\/v1\/email\/contact\/?$/, methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/newsletter/open\\.gif`), methods: ['GET', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/newsletter/unsubscribe`), methods: ['GET', 'OPTIONS'] },

      // Public campaigns / partnership / voting (route middleware still checks customer JWT for vote)
      { url: new RegExp(`^${apiEsc}/campaigns/public(/.*)?$`), methods: ['GET', 'OPTIONS'] },
      {
        url: new RegExp(`^${apiEsc}/votingcampaigns/public`),
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      },
      { url: new RegExp(`^${apiEsc}/public/partnership-pricing/?$`), methods: ['GET', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/public/partnership-quote/[^/]+/?$`), methods: ['GET', 'PATCH', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/public/partnership-quote/[^/]+/submit/?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/legal/policies/?$`), methods: ['GET', 'OPTIONS'] },

      // Tracking ingest (no JWT; rate-limited separately)
      { url: new RegExp(`^${apiEsc}/events(/.*)?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/events/health/?$`), methods: ['GET', 'OPTIONS'] },

      // Payment / Meta webhooks
      { url: new RegExp(`^${apiEsc}/payments/payfast/itn/?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/saas/billing/payfast/itn/?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/saas/webhooks/whatsapp/?$`), methods: ['GET', 'POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/saas/webhooks/meta-ads/?$`), methods: ['GET', 'POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/saas/meta/oauth/callback/?$`), methods: ['GET', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/saas/meta/oauth/complete/?$`), methods: ['POST', 'OPTIONS'] },
      `${api}/orders/update-order-payment`,
      { url: new RegExp(`^${apiEsc}/bookings/[^/]+/payment-confirmation/?$`), methods: ['POST', 'OPTIONS'] },

      // Storefront discount check
      `${api}/discountcode/verify-discount-code`,
    ],
  });
};

module.exports = authJwt;
