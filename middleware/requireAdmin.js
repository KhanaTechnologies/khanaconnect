const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');

/**
 * Verifies Bearer JWT and ensures the Client document has role === 'admin'.
 * Attaches req.user (decoded JWT) and req.adminClient (lean client summary).
 */
async function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const token = auth.split(' ')[1];
    const { decoded } = verifyJwtWithAnySecret(jwt, token);
    const client = await Client.findOne({ clientID: decoded.clientID }).select(
      'clientID companyName role'
    );
    if (!client) {
      return res.status(404).json({ success: false, error: 'Client not found' });
    }
    if (client.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    req.user = decoded;
    req.adminClient = {
      clientID: client.clientID,
      companyName: client.companyName,
      role: client.role,
    };
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

module.exports = { requireAdmin };
