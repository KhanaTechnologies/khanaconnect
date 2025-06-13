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
     { url: /\/public\/uploads(.*)/, methods: ['GET', 'OPTIONS'] },
     { url: /\/api\/v1\/customer(.*)/, methods: ['GET', 'OPTIONS'] },
    //  { url: /\/api\/v1\/notifications(.*)/, methods: ['GET', 'OPTIONS'] }, 
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
     { url: /\/api\/v1\/users(.*)/, methods:['GET','OPTIONS']},
     { url: /\/api\/v1\/email(.*)/, methods:['GET','OPTIONS']},
     { url: /\/api\/v1\/orders(.*)/, methods:['GET','OPTIONS']},
     { url: /\/api\/v1\/product(.*)/, methods: ['GET'] },
     { url: /\/api\/v1\/productsales(.*)/, methods: ['GET'] },
     `${api}/emailsub/subscribe`,
     `${api}/orders/update-order-payment`,
     `${api}/customer/reset-password`,
     `${api}/customer/reset-password/:token`,
     `${api}/users/login`,
     `${api}/users/register`,
    `${api}/customer/login`,
     `${api}/customer/register`,
     `${api}/client/login`,
     `${api}/client/register`,
      // { url: /(.*)/ } 
    ]
  })
}

async function isRevoked(req, token) {

  // Skip revocation check for password reset routes
  if (req.originalUrl.includes('/customer/reset-password/')) {
    return false;
  }

  if (!token.payload.isActive) {
    return true;
  }
  return false;
}


module.exports = authJwt;
