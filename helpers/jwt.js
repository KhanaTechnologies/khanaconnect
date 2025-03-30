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
     { url: /\/public\/uploads(.*)/, methods: ['GET', 'OPTIONS','POST', 'PUT'] },
     { url: /\/api\/v1\/customer(.*)/, methods: ['GET', 'OPTIONS', 'POST', 'DELETE'] },
    //  { url: /\/api\/v1\/notifications(.*)/, methods: ['GET', 'OPTIONS'] }, 
     { url: /\/api\/v1\/client(.*)/, methods: ['GET', 'OPTIONS','POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/categories(.*)/, methods: ['GET', 'OPTIONS','POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/tradecation(.*)/, methods: ['GET', 'OPTIONS','POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/membership(.*)/, methods: ['GET', 'OPTIONS','POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/module(.*)/, methods: ['GET', 'OPTIONS', 'POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/signal(.*)/, methods: ['GET', 'OPTIONS', 'POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/bookings(.*)/, methods: ['GET', 'OPTIONS', 'POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/services(.*)/, methods: ['GET', 'OPTIONS', 'POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/staff(.*)/, methods: ['GET', 'OPTIONS', 'POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/admin(.*)/, methods: ['GET', 'OPTIONS', 'POST', 'PUT', 'DELETE'] },
     { url: /\/api\/v1\/users(.*)/, methods:['GET','OPTIONS','POST', 'PUT']},
     { url: /\/api\/v1\/email(.*)/, methods:['GET','OPTIONS','POST', 'PUT']},
     `${api}/users/login`,
     `${api}/users/register`,
     `${api}/protected`,
     `${api}/product`
      // { url: /(.*)/ } 
    ]
  })
}

async function isRevoked(req,payload,done){
 return
  // if(payload.payload.isAdmin){
 
  //   return 
  // }else{
  //   return payload='null'
  // }
}

module.exports = authJwt;
