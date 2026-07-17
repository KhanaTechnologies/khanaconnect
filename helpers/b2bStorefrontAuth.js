const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const B2BBuyer = require('../models/B2BBuyer');
const { verifyJwtWithAnySecret } = require('./jwtSecret');
const { getJwtSecret } = require('./jwtSecret');
const {
  isClientSubscriptionActive,
  subscriptionBlockedResponse,
} = require('./clientSubscription');

function extractBearerToken(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.split(' ')[1];
}

async function validateStorefrontClientToken(req, res, next) {
  try {
    const tokenValue = extractBearerToken(req);
    if (!tokenValue) {
      return res.status(401).json({ error: 'Unauthorized — client token required' });
    }

    const { decoded } = verifyJwtWithAnySecret(jwt, tokenValue);
    if (!decoded?.clientID) {
      return res.status(403).json({ error: 'Invalid client token' });
    }

    const client = await Client.findOne({ clientID: decoded.clientID }).select(
      'clientID companyName role subscription permissions'
    );
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    if (!isClientSubscriptionActive(client)) {
      return subscriptionBlockedResponse(res, client);
    }
    if (!client.permissions?.b2b) {
      return res.status(403).json({ error: 'B2B module is not enabled for this account' });
    }

    req.clientID = client.clientID;
    req.storefrontClient = client;
    return next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid token' });
  }
}

async function requireApprovedBuyer(req, res, next) {
  try {
    const tokenValue = extractBearerToken(req);
    if (!tokenValue) {
      return res.status(401).json({ error: 'Unauthorized — buyer session required' });
    }

    const { decoded } = verifyJwtWithAnySecret(jwt, tokenValue);
    if (!decoded?.buyerId || decoded.role !== 'b2b') {
      return res.status(403).json({ error: 'Invalid buyer session' });
    }
    if (decoded.verified === false) {
      return res.status(403).json({ error: 'Two-factor verification required' });
    }

    const buyer = await B2BBuyer.findById(decoded.buyerId).select('+passwordHash');
    if (!buyer || buyer.clientID !== decoded.clientID) {
      return res.status(404).json({ error: 'Buyer account not found' });
    }
    if (buyer.status !== 'approved') {
      return res.status(403).json({ error: 'Buyer account is not approved yet' });
    }
    if (!buyer.canOrder && req.method !== 'GET') {
      return res.status(403).json({ error: 'Your account does not have ordering permissions' });
    }

    req.buyer = buyer;
    req.clientID = buyer.clientID;
    return next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid buyer session' });
  }
}

function signBuyerToken(buyer, client, { verified = true } = {}) {
  const { mergeB2bSettings } = require('./b2bDefaults');
  const settings = mergeB2bSettings(client);
  const hours = Math.max(1, Number(settings.sessionHours) || 24);
  return jwt.sign(
    {
      buyerId: String(buyer._id),
      clientID: buyer.clientID,
      role: 'b2b',
      canOrder: !!buyer.canOrder,
      verified: !!verified,
      sessionVersion: 2,
    },
    getJwtSecret(),
    { expiresIn: `${hours}h` }
  );
}

module.exports = {
  validateStorefrontClientToken,
  requireApprovedBuyer,
  signBuyerToken,
};
