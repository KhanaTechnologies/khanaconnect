const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const router = express.Router();
const authJwt = require('../helpers/jwt'); // Import the authJwt middleware
const rateLimit = require('express-rate-limit');
const { wrapRoute } = require('../helpers/failureEmail');

router.use(authJwt());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Helper function to generate a JWT token
function generateToken(client) {
  const secret = process.env.secret;
  const payload = {
    clientID: client.clientID,
    companyName: client.companyName,
    merchant_id: client.merchant_id,
    merchant_key: client.merchant_key,
    passphrase: client.passphrase,
  };
  return jwt.sign(payload, secret, { expiresIn: '1y' });
}

// Middleware to authenticate token
function authenticateToken(req, res, next) {
  try {
    const token = req.headers.authorization;
    const secret = process.env.secret;
    if (!token) return res.status(401).json({ error: 'Unauthorized - Token missing' });

    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, secret, (err, user) => {
      if (err) return res.status(403).json({ error: 'Forbidden - Invalid token' });
      req.user = user;
      next();
    });
  } catch (error) {
    next(error);
  }
}

// Create a new client
router.post('/', wrapRoute(async (req, res) => {
  const { clientID, companyName, merchant_id, merchant_key, password, passphrase, return_url, cancel_url, notify_url, businessEmail, businessEmailPassword, tier, role, permissions, deliveryOptions } = req.body;
  
  const hashedPassword = bcrypt.hashSync(password, 10);
  const token = generateToken({ clientID, companyName, merchant_id });

  const newClient = new Client({
    clientID,
    companyName,
    password: hashedPassword,
    merchant_id,
    merchant_key,
    passphrase,
    token,
    return_url,
    cancel_url,
    notify_url,
    businessEmail,
    businessEmailPassword,
    tier,
    role,
    permissions,
    deliveryOptions
  });

  const savedClient = await newClient.save();
  res.json({ client: savedClient, token });
}));

// Get all clients
router.get('/', wrapRoute(async (req, res) => {
  const clients = await Client.find();
  res.json(clients);
}));

// Protected route
router.get('/protected', authenticateToken, wrapRoute(async (req, res) => {
  res.json({ message: 'This is a protected route.', user: req.user });
}));

// Get client by ID
router.get('/:clientId', wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientId });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json(client);
}));

// Edit client details
router.put('/:clientId', wrapRoute(async (req, res) => {
  const updates = req.body;
  if (updates.password) updates.password = bcrypt.hashSync(updates.password, 10);
  const updatedClient = await Client.findOneAndUpdate({ clientID: req.params.clientId }, updates, { new: true });
  if (!updatedClient) return res.status(404).json({ error: 'Client not found' });
  res.json(updatedClient);
}));

// Client login
router.post('/login', loginLimiter, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.body.clientID });
  if (!client) return res.status(400).send('The client could not be found');

  if (bcrypt.compareSync(req.body.password, client.password)) {
    const token = jwt.sign({ clientID: client.clientID, merchant_id: client.merchant_id, isActive: true }, process.env.secret, { expiresIn: '1d' });

    if (client.isLoggedIn) {
      client.sessionToken = null;
      client.sessionExpires = null;
    }
    client.sessionToken = token;
    client.sessionExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    client.isLoggedIn = true;
    await client.save();

    res.status(200).send({
      ID: client.clientID,
      merchant_id: client.merchant_id,
      token,
      permissions: client.permissions,
      role: client.role
    });
  } else {
    res.status(400).send('The user email and password are incorrect!');
  }
}));

// Client logout
router.post('/logout', wrapRoute(async (req, res) => {
  const token = req.headers.authorization.split(' ')[1];
  const decoded = jwt.verify(token, process.env.secret);
  const client = await Client.findOne({ clientID: decoded.clientID });
  if (!client) return res.status(400).send('Client not found');

  client.sessionToken = null;
  client.sessionExpires = null;
  client.isLoggedIn = false;
  await client.save();

  res.status(200).send('Logout successful');
}));

module.exports = router;
