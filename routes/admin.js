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
const { SalesItem } = require('../models/salesItem')
const DiscountCode = require("../models/discountCode");

const router = express.Router();

// Helper function to get the clientID from the client object _id
async function getClientIDFromParams(clientIdParam) {
  try {
    const client = await Client.findById(clientIdParam);
    if (!client) {
      throw new Error('Client not found');
    }
    return client.clientID;
  } catch (error) {
    throw new Error('Error fetching clientID: ' + error.message);
  }
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

// Admin route to check the time until a client's token expires
router.get('/clients/:id/token-expiration', authJwt(), async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function

    // Fetch the client from the database
    const client = await Client.findOne({ clientID });

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Check if the client has a token
    const token = client.token;
    if (!token) {
      return res.status(400).json({ error: 'Client does not have a token' });
    }

    // Decode the token to get the expiration time (exp field)
    const decoded = jwt.decode(token);

    if (!decoded || !decoded.exp) {
      return res.status(400).json({ error: 'Token is invalid or does not contain an expiration time' });
    }

    // Get the current time and the expiration time in seconds
    const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
    const expirationTime = decoded.exp; // Expiration time in seconds

    // Calculate the time remaining until expiration
    const timeRemaining = expirationTime - currentTime;

    if (timeRemaining <= 0) {
      return res.status(200).json({ message: 'Token has already expired' });
    }

    // Convert the time remaining into hours, minutes, and seconds
    const hours = Math.floor(timeRemaining / 3600);
    const minutes = Math.floor((timeRemaining % 3600) / 60);
    const seconds = timeRemaining % 60;

    // Return the remaining time until the token expires
    res.status(200).json({
      message: 'Token expires in:',
      hours,
      minutes,
      seconds,
    });

  } catch (error) {
    console.error('Error checking client token expiration:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin route to generate a new token for a client
router.post('/clients/:id/generate-client-token', authJwt(), async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function
    // Fetch the client from the database
    const client = await Client.findOne({ clientID });

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Generate a new token for the client
    const newToken = generateToken(client);

    // Update the client's token field in the database
    client.token = newToken;
    await client.save();

    res.status(200).json({ message: 'New token generated successfully', token: newToken });
  } catch (error) {
    console.error('Error generating client token:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Admin route to delete a token for a client
router.post('/clients/:id/delete-client-token', authJwt(), async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function

    // Fetch the client from the database
    const client = await Client.findOne({ clientID });

    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Delete the client's token (set it to null)
    client.token = null;
    await client.save();

    res.status(200).json({ message: 'Client token deleted successfully' });
  } catch (error) {
    console.error('Error deleting client token:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


// 🔹 GET all clients
router.get("/clients", async (req, res) => {
  try {
    const clients = await Client.find();
    res.json(clients);
  } catch (error) {
    res.status(500).json({ error: "Error fetching clients" });
  }
});

// 🔹 GET a single client by ID
router.get("/clients/:id", async (req, res) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) return res.status(404).json({ error: "Client not found" });
    res.json(client);
  } catch (error) {
    res.status(500).json({ error: "Error fetching client" });
  }
});

// 🔹 UPDATE client details
router.put("/clients/:id", async (req, res) => {
  try {
    const updatedClient = await Client.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(updatedClient);
  } catch (error) {
    res.status(500).json({ error: "Error updating client" });
  }
});

// 🔹 GET total number of clients
router.get("/numberOfClients", async (req, res) => {
  try {
    const count = await Client.countDocuments();
    res.json({ totalClients: count });
  } catch (error) {
    res.status(500).json({ error: "Error counting clients" });
  }
});

// 🔹 GET number of orders for a client
router.get("/clients/:id/numberOfOrders", async (req, res) => {
  try {

    const { id } = req.params; // Get client _id from params
    const clientId = await getClientIDFromParams(id); // Get clientID using helper function
    const count = await Order.countDocuments({ clientID: clientId });
    res.json({ totalOrders: count });
  } catch (error) {
    res.status(500).json({ error: "Error counting orders" });
  }
});

// 🔹 GET number of products for a client
router.get("/clients/:id/numberOfProducts", async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function
    const count = await Product.countDocuments({ clientID: clientID });
    res.json({ totalProducts: count });
  } catch (error) {
    res.status(500).json({ error: "Error counting products" });
  }
});

// 🔹 GET number of categories for a client
router.get("/clients/:id/numberOfCategories", async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function
    const count = await Category.countDocuments({ clientID: clientID });
    res.json({ totalCategories: count });
  } catch (error) {
    res.status(500).json({ error: "Error counting categories" });
  }
});

// 🔹 GET number of bookings for a client
router.get("/clients/:id/numberOfBookings", async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function
    const count = await Booking.countDocuments({ clientID: clientID });
    res.json({ totalBookings: count });
  } catch (error) {
    res.status(500).json({ error: "Error counting bookings" });
  }
});

// 🔹 GET number of services for a client
router.get("/clients/:id/numberOfServices", async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function
    const count = await Service.countDocuments({ clientID: clientID });
    res.json({ totalServices: count });
  } catch (error) {
    res.status(500).json({ error: "Error counting services" });
  }
});

// 🔹 GET number of staff for a client
router.get("/clients/:id/numberOfStaff", async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function
    const count = await Staff.countDocuments({ clientID: clientID });
    res.json({ totalStaff: count });
  } catch (error) {
    res.status(500).json({ error: "Error counting staff" });
  }
});

// 🔹 GET number of sales for a client
router.get("/clients/:id/numberOfSales", async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function
    const count = await SalesItem.countDocuments({ clientID: clientID });
    res.json({ totalSales: count });
  } catch (error) {
    res.status(500).json({ error: "Error counting sales" });
  }
});

// 🔹 GET number of discount codes for a client
router.get("/clients/:id/numberOfDiscountCodes", async (req, res) => {
  try {
    const { id } = req.params; // Get client _id from params
    const clientID = await getClientIDFromParams(id); // Get clientID using helper function
    const count = await DiscountCode.countDocuments({ clientID: clientID });
    res.json({ totalDiscountCodes: count });
  } catch (error) {
    res.status(500).json({ error: "Error counting discount codes" });
  }
});

module.exports = router;
