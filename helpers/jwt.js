const { expressjwt } = require('express-jwt');
const { getJwtSecret } = require('./jwtSecret');

/**
 * Global JWT gate for /api/v1.
 * Only truly public paths are exempt. Everything else must present a valid Bearer JWT;
 * route-level middleware still enforces tenant ownership / admin / storefront rules.
 */
const authJwt = () => {
  const secret = getJwtSecret();
  const api = process.env.API_URL || '/api/v1';
  const apiEsc = api.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return expressjwt({
    secret,
    algorithms: ['HS256'],
    isRevoked: isRevoked,
  }).unless({
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

      // Public email / newsletter
      { url: /\/api\/v1\/emailsub\/(subscribe|unsubscribe)\/?$/, methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/subscribe/?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/unsubscribe/?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/contact/?$`), methods: ['POST', 'OPTIONS'] },
      { url: /\/api\/v1\/email\/contact\/?$/, methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/newsletter/open\\.gif`), methods: ['GET', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/email/newsletter/unsubscribe`), methods: ['GET', 'OPTIONS'] },

      // Public campaigns / partnership
      { url: new RegExp(`^${apiEsc}/campaigns/public(/.*)?$`), methods: ['GET', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/votingcampaigns/public`), methods: ['GET', 'POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/public/partnership-pricing/?$`), methods: ['GET', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/public/partnership-quote/[^/]+/?$`), methods: ['GET', 'PATCH', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/public/partnership-quote/[^/]+/submit/?$`), methods: ['POST', 'OPTIONS'] },

      // Tracking ingest (no JWT; rate-limited separately)
      { url: new RegExp(`^${apiEsc}/events(/.*)?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/events/health/?$`), methods: ['GET', 'OPTIONS'] },

      // Payment / Meta webhooks
      { url: new RegExp(`^${apiEsc}/payments/payfast/itn/?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/saas/billing/payfast/itn/?$`), methods: ['POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/saas/webhooks/whatsapp/?$`), methods: ['GET', 'POST', 'OPTIONS'] },
      { url: new RegExp(`^${apiEsc}/saas/webhooks/meta-ads/?$`), methods: ['GET', 'POST', 'OPTIONS'] },
      `${api}/orders/update-order-payment`,
      { url: new RegExp(`^${apiEsc}/bookings/[^/]+/payment-confirmation/?$`), methods: ['POST', 'OPTIONS'] },

      // Storefront discount check
      `${api}/discountcode/verify-discount-code`,
    ],
  });
};

async function isRevoked(req, token) {
  // Skip revocation check for password reset routes
  if (req.originalUrl.includes('/customer/reset-password/')) {
    return false;
  }
  // Skip revocation check for verify routes
  if (req.originalUrl.includes('/customer/verify/')) {
    return false;
  }
  // Skip revocation check for verify routes
  if (req.originalUrl.includes('/customer/login')) {
    return false;
  }

  if (token.payload.hasOwnProperty('isActive') && !token.payload.isActive) {
    return true;
  }
  return false;
}

module.exports = authJwt;
