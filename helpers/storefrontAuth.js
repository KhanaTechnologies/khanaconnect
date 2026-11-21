/**
 * Auth for public client websites (storefronts).
 *
 * A client website ships the client's storefront JWT (`client.token`) in its public code, so
 * this middleware only answers "which client is this website for?". It accepts that token, a
 * logged-in shopper's token (also carries clientID) or a team token, and rejects purpose
 * tokens (one-off links) and B2B buyer tokens, which are not meant for the retail site.
 *
 * Sets req.clientId / req.clientID and req.storefrontClient, and blocks clients whose
 * subscription is not active (same rule as the dashboard).
 */
const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const { verifyJwtWithAnySecret } = require('./jwtSecret');
const { isClientSubscriptionActive, subscriptionBlockedResponse } = require('./clientSubscription');

const CLIENT_FIELDS =
  'role subscription clientID companyName return_url cancel_url deliveryOptions revenueSettings whatsapp';

function createStorefrontAuth({ ClientModel = Client, verify = verifyJwtWithAnySecret } = {}) {
  return async function storefrontAuth(req, res, next) {
    let decoded;
    try {
      const header = String(req.headers.authorization || '');
      if (!header.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Website token missing' });
      }
      ({ decoded } = verify(jwt, header.slice(7).trim()));
    } catch (_err) {
      return res.status(401).json({ error: 'Invalid website token' });
    }

    const clientID = decoded && (decoded.clientID || decoded.clientId);
    // Same token-type rules as helpers/teamAuth.js resolveSessionFromToken.
    const isBuyer = decoded && (decoded.buyerId || decoded.role === 'b2b' || decoded.loginType === 'b2b');
    if (!clientID || decoded.purpose || isBuyer) {
      return res.status(403).json({ error: 'Invalid website token' });
    }

    const client = await ClientModel.findOne({ clientID }).select(CLIENT_FIELDS);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    if (!isClientSubscriptionActive(client)) return subscriptionBlockedResponse(res, client);

    req.clientId = clientID;
    req.clientID = clientID;
    req.storefrontClient = client;
    req.storefrontCustomerId = decoded.customerID ? String(decoded.customerID) : '';
    return next();
  };
}

module.exports = { createStorefrontAuth, storefrontAuth: createStorefrontAuth() };
