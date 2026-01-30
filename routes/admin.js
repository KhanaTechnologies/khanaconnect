// routes/client.js
const express = require("express");
const jwt = require('jsonwebtoken');
const authJwt = require('../helpers/jwt'); // Import the authJwt middleware
const Client = require("../models/client");
const { Order } = require('../models/order');
const Product = require("../models/product");
const { Category } = require("../models/category");
const Booking = require("../models/booking");
const Service = require("../models/service");
const Staff = require("../models/staff");
const { SalesItem } = require('../models/salesItem');
const DiscountCode = require("../models/discountCode");

const { wrapRoute } = require('../helpers/failureEmail'); // <- wrapRoute for automatic emails

const router = express.Router();

// Helper function to get the clientID from the client object _id
async function getClientIDFromParams(clientIdParam) {
  const client = await Client.findById(clientIdParam);
  if (!client) {
    const err = new Error('Client not found');
    err.status = 404;
    throw err;
  }
  return client.clientID;
}

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

/**
 * Admin route to check the time until a client's token expires
 * Protected by authJwt()
 */
router.get('/clients/:id/token-expiration', authJwt(), wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const client = await Client.findOne({ clientID });

  if (!client) return res.status(404).json({ error: 'Client not found' });

  const token = client.token;
  if (!token) return res.status(400).json({ error: 'Client does not have a token' });

  const decoded = jwt.decode(token);
  if (!decoded || !decoded.exp) return res.status(400).json({ error: 'Token is invalid or does not contain an expiration time' });

  const currentTime = Math.floor(Date.now() / 1000);
  const expirationTime = decoded.exp;
  const timeRemaining = expirationTime - currentTime;

  if (timeRemaining <= 0) return res.status(200).json({ message: 'Token has already expired' });

  const hours = Math.floor(timeRemaining / 3600);
  const minutes = Math.floor((timeRemaining % 3600) / 60);
  const seconds = timeRemaining % 60;

  res.status(200).json({
    message: 'Token expires in:',
    hours,
    minutes,
    seconds,
  });
}));

/**
 * Admin route to generate a new token for a client
 */
router.post('/clients/:id/generate-client-token', authJwt(), wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const client = await Client.findOne({ clientID });

  if (!client) return res.status(404).json({ error: 'Client not found' });

  const newToken = generateToken(client);
  client.token = newToken;
  await client.save();

  res.status(200).json({ message: 'New token generated successfully', token: newToken });
}));

/**
 * Admin route to delete a token for a client
 */
router.post('/clients/:id/delete-client-token', authJwt(), wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const client = await Client.findOne({ clientID });

  if (!client) return res.status(404).json({ error: 'Client not found' });

  client.token = null;
  await client.save();

  res.status(200).json({ message: 'Client token deleted successfully' });
}));

// 🔹 GET all clients
router.get("/clients", wrapRoute(async (req, res) => {
  const clients = await Client.find();
  res.json(clients);
}));

// 🔹 GET a single client by ID
router.get("/clients/:id", wrapRoute(async (req, res) => {
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ error: "Client not found" });
  res.json(client);
}));

// 🔹 UPDATE client details
router.put("/clients/:id", wrapRoute(async (req, res) => {
  const updatedClient = await Client.findByIdAndUpdate(req.params.id, req.body, { new: true });
  if (!updatedClient) return res.status(404).json({ error: "Client not found" });
  res.json(updatedClient);
}));

// 🔹 GET total number of clients
router.get("/numberOfClients", wrapRoute(async (req, res) => {
  const count = await Client.countDocuments();
  res.json({ totalClients: count });
}));

// 🔹 GET number of orders for a client
router.get("/clients/:id/numberOfOrders", wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientId = await getClientIDFromParams(id);
  const count = await Order.countDocuments({ clientID: clientId });
  res.json({ totalOrders: count });
}));

// 🔹 GET number of products for a client
router.get("/clients/:id/numberOfProducts", wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const count = await Product.countDocuments({ clientID: clientID });
  res.json({ totalProducts: count });
}));

// 🔹 GET number of categories for a client
router.get("/clients/:id/numberOfCategories", wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const count = await Category.countDocuments({ clientID: clientID });
  res.json({ totalCategories: count });
}));

// 🔹 GET number of bookings for a client
router.get("/clients/:id/numberOfBookings", wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const count = await Booking.countDocuments({ clientID: clientID });
  res.json({ totalBookings: count });
}));

// 🔹 GET number of services for a client
router.get("/clients/:id/numberOfServices", wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const count = await Service.countDocuments({ clientID: clientID });
  res.json({ totalServices: count });
}));

// 🔹 GET number of staff for a client
router.get("/clients/:id/numberOfStaff", wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const count = await Staff.countDocuments({ clientID: clientID });
  res.json({ totalStaff: count });
}));

// 🔹 GET number of sales for a client
router.get("/clients/:id/numberOfSales", wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const count = await SalesItem.countDocuments({ clientID: clientID });
  res.json({ totalSales: count });
}));

// 🔹 GET number of discount codes for a client
router.get("/clients/:id/numberOfDiscountCodes", wrapRoute(async (req, res) => {
  const { id } = req.params;
  const clientID = await getClientIDFromParams(id);
  const count = await DiscountCode.countDocuments({ clientID: clientID });
  res.json({ totalDiscountCodes: count });
}));

module.exports = router;
