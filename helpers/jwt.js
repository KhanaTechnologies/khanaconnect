const { expressjwt } = require('express-jwt');
 
const authJwt = () => {
  const secret = process.env.secret;
  const api = process.env.API_URL;
  return expressjwt({
    secret,
    algorithms: ['HS256'],
    isRevoked: isRevoked
  }).unless({
    path: [
  { url: /\/api\/v1\/emailsub(.*)/, methods: ['POST', 'OPTIONS'] },
  { url: /\/public\/uploads(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/customer(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/client(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/categories(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/tradecation(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/membership(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/module(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/signal(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/bookings(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/services(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/staff(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/admin(.*)/, methods: ['GET', 'OPTIONS'] },
  { url: /\/api\/v1\/users(.*)/, methods: ['GET','OPTIONS'] },
  { url: /\/api\/v1\/email(.*)/, methods: ['GET','OPTIONS'] },
  { url: /\/api\/v1\/orders(.*)/, methods: ['GET','OPTIONS'] },
  { url: /\/api\/v1\/product(.*)/, methods: ['GET'] },
  { url: /\/api\/v1\/productsales(.*)/, methods: ['GET'] },
  { url: /\/api\/v1\/orders\/update-order-payment/, methods: ['POST'] },
  { url: /\/api\/v1\/customer\/reset-password(.*)/, methods: ['POST'] },
  { url: /\/api\/v1\/customer\/verify(.*)/, methods: ['GET'] },
  { url: /\/api\/v1\/users\/login/, methods: ['POST'] },
  { url: /\/api\/v1\/users\/register/, methods: ['POST'] },
  { url: /\/api\/v1\/customer\/login/, methods: ['POST'] },
  { url: /\/api\/v1\/customer\/register/, methods: ['POST'] },
  { url: /\/api\/v1\/customer\/registration/, methods: ['POST'] },
  { url: /\/api\/v1\/client\/login/, methods: ['POST'] },
  { url: /\/api\/v1\/client\/register/, methods: ['POST'] },
  { url: /\/api\/v1\/discountcode\/verify-discount-code/, methods: ['POST'] }
      // { url: /(.*)/ } 
    ]
  })
}

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

  if (!token.payload.isActive) {
    return true;
  }
  return false;
}


module.exports = authJwt;
