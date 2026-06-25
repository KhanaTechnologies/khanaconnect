// routes/admin.js
const express = require("express");
const jwt = require('jsonwebtoken');
const authJwt = require('../helpers/jwt'); // Import the authJwt middleware
const bcrypt = require('bcryptjs');
const Client = require("../models/client");
const { Order } = require('../models/order');
const Product = require("../models/product");
const { Category } = require("../models/category");
const Booking = require("../models/booking");
const Service = require("../models/service");
const Staff = require("../models/staff");
const { SalesItem } = require('../models/salesItem');
const DiscountCode = require("../models/discountCode");
const { getJwtSecret } = require('../helpers/jwtSecret');
const { requireAdmin } = require('../middleware/requireAdmin');
const { createClientRecord } = require('../helpers/clientCreate');
const {
  serializeSubscriptionSummary,
  applySubscriptionUpdate,
  isClientSubscriptionActive,
} = require('../helpers/clientSubscription');
const TeamMember = require('../models/teamMember');
const {
  normalizeTeamEmail,
  teamMemberEmailExists,
} = require('../helpers/teamMemberLookup');
const {
  changeTeamMemberLoginEmail,
} = require('../helpers/teamMemberEmail');
const { issueTeamPasswordReset, issueLegacyTeamPasswordReset } = require('../helpers/teamPasswordReset');
const { fullPermissions, normalizePermissions, permissionsFromClient } = require('../helpers/teamPermissions');

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
  const secret = getJwtSecret();
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

function formatClientForAdmin(client) {
  const json = client.toObject ? client.toObject() : client;
  const summary = serializeSubscriptionSummary(client);
  return {
    ...json,
    active: summary.isActive,
    subscriptionSummary: summary,
  };
}

// 🔹 GET all clients
router.get("/clients", requireAdmin, wrapRoute(async (req, res) => {
  const clients = await Client.find().select('-password -token -sessionToken');
  res.json(clients.map((c) => formatClientForAdmin(c)));
}));

// 🔹 CREATE a new client (admin dashboard)
router.post("/clients", requireAdmin, wrapRoute(async (req, res) => {
  try {
    const { client, token } = await createClientRecord(req.body);
    res.status(201).json({ success: true, client, token });
  } catch (error) {
    const status = error.status && Number(error.status) >= 400 ? error.status : 500;
    return res.status(status).json({
      success: false,
      error: error.message || 'Failed to create client',
    });
  }
}));

// 🔹 GET a single client by ID
router.get("/clients/:id", requireAdmin, wrapRoute(async (req, res) => {
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ error: "Client not found" });
  res.json(client);
}));

// 🔹 UPDATE client details
router.put("/clients/:id", requireAdmin, wrapRoute(async (req, res) => {
  const updates = { ...req.body };

  if (updates.password) {
    updates.password = bcrypt.hashSync(updates.password, 10);
  }

  delete updates._id;
  delete updates.clientID;
  delete updates.token;
  delete updates.sessionToken;

  const updatedClient = await Client.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true })
    .select('-password -token -sessionToken');

  if (!updatedClient) return res.status(404).json({ error: "Client not found" });
  res.json(formatClientForAdmin(updatedClient));
}));

// 🔹 Subscription billing (monthly partnership access)
router.get("/clients/:id/subscription", requireAdmin, wrapRoute(async (req, res) => {
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ error: "Client not found" });
  res.json({ success: true, subscription: serializeSubscriptionSummary(client) });
}));

router.put("/clients/:id/subscription", requireAdmin, wrapRoute(async (req, res) => {
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ error: "Client not found" });

  const subscription = applySubscriptionUpdate(client, req.body);
  await client.save();

  res.json({
    success: true,
    message: 'Subscription updated',
    subscription,
    client: formatClientForAdmin(client),
  });
}));

router.post("/clients/:id/subscription/reinstate", requireAdmin, wrapRoute(async (req, res) => {
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ error: "Client not found" });

  const subscription = applySubscriptionUpdate(client, { ...req.body, action: 'reinstate' });
  await client.save();

  res.json({
    success: true,
    message: 'Access reinstated',
    subscription,
    client: formatClientForAdmin(client),
  });
}));

router.post("/clients/:id/subscription/suspend", requireAdmin, wrapRoute(async (req, res) => {
  const client = await Client.findById(req.params.id);
  if (!client) return res.status(404).json({ error: "Client not found" });

  const subscription = applySubscriptionUpdate(client, { ...req.body, action: 'suspend' });
  await client.save();

  res.json({
    success: true,
    message: 'Client access suspended',
    subscription,
    client: formatClientForAdmin(client),
  });
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

// 🔹 UPDATE client permissions (Admin only)
router.put("/clients/:id/permissions", requireAdmin, wrapRoute(async (req, res) => {
  const { id } = req.params;
  const { permissions } = req.body;
  
  // Find the client by ID
  const client = await Client.findById(id);
  if (!client) {
    return res.status(404).json({ error: "Client not found" });
  }

  // Update permissions
  client.permissions = {
    ...client.permissions, // Keep existing permissions
    ...permissions // Override with new permissions
  };

  await client.save();

  res.json({
    success: true,
    message: "Client permissions updated successfully",
    client: {
      _id: client._id,
      clientID: client.clientID,
      companyName: client.companyName,
      permissions: client.permissions
    }
  });
}));

function sanitizeTeamMember(member) {
  const json = member.toJSON ? member.toJSON() : member;
  delete json.passwordHash;
  return json;
}

// Team management for a client (Khana admin only)
router.get('/clients/:id/team', requireAdmin, wrapRoute(async (req, res) => {
  const clientID = await getClientIDFromParams(req.params.id);
  const members = await TeamMember.find({ clientID }).sort({ orgRole: 1, createdAt: 1 });
  res.json({
    success: true,
    clientID,
    members: members.map(sanitizeTeamMember),
  });
}));

router.post('/clients/:id/team', requireAdmin, wrapRoute(async (req, res) => {
  const clientID = await getClientIDFromParams(req.params.id);
  const client = await Client.findOne({ clientID });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const {
    email,
    password,
    firstName,
    lastName,
    orgRole = 'member',
    permissions,
  } = req.body;

  const normalizedEmail = normalizeTeamEmail(email);
  if (!normalizedEmail || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Email and password (min 6 characters) are required' });
  }

  if (orgRole === 'owner') {
    const existingOwner = await TeamMember.findOne({ clientID, orgRole: 'owner' });
    if (existingOwner) {
      return res.status(409).json({ error: 'This client already has an owner. Update the existing owner instead.' });
    }
  }

  if (await teamMemberEmailExists(clientID, normalizedEmail)) {
    return res.status(409).json({ error: 'A team member with this email already exists' });
  }

  const memberPermissions = permissions
    ? normalizePermissions(permissions)
    : orgRole === 'owner'
      ? fullPermissions()
      : permissionsFromClient(client);

  const passwordHash = bcrypt.hashSync(password, 10);

  const member = await TeamMember.create({
    clientID,
    email: normalizedEmail,
    firstName: firstName || '',
    lastName: lastName || '',
    passwordHash,
    orgRole: ['owner', 'admin', 'manager', 'member'].includes(orgRole) ? orgRole : 'member',
    permissions: memberPermissions,
    status: 'active',
  });

  if (orgRole === 'owner') {
    await Client.updateOne({ clientID }, { $set: { password: passwordHash } });
  }

  res.status(201).json({
    success: true,
    message: 'Team member created',
    member: sanitizeTeamMember(member),
  });
}));

router.put('/clients/:id/team/:memberId', requireAdmin, wrapRoute(async (req, res) => {
  const clientID = await getClientIDFromParams(req.params.id);
  let member = await TeamMember.findOne({ _id: req.params.memberId, clientID }).select('+passwordHash');
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  const { email, firstName, lastName, orgRole, status, password } = req.body;

  if (email) {
    try {
      await changeTeamMemberLoginEmail({
        clientID,
        memberId: member._id,
        newEmail: email,
      });
      member = await TeamMember.findById(member._id).select('+passwordHash');
    } catch (err) {
      return res.status(err.status || 500).json({ error: err.message || 'Failed to update login email' });
    }
  }

  if (typeof firstName === 'string') member.firstName = firstName;
  if (typeof lastName === 'string') member.lastName = lastName;

  if (orgRole && member.orgRole !== 'owner') {
    if (!['admin', 'manager', 'member'].includes(orgRole)) {
      return res.status(400).json({ error: 'Invalid org role' });
    }
    member.orgRole = orgRole;
  }

  if (status && member.orgRole !== 'owner') {
    if (!['active', 'disabled', 'invited'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    member.status = status;
  }

  if (password && String(password).length >= 6) {
    member.passwordHash = bcrypt.hashSync(password, 10);
    if (member.orgRole === 'owner') {
      await Client.updateOne({ clientID }, { $set: { password: member.passwordHash } });
    }
  }

  await member.save();
  const fresh = await TeamMember.findById(member._id);
  res.json({ success: true, member: sanitizeTeamMember(fresh) });
}));

router.delete('/clients/:id/team/:memberId', requireAdmin, wrapRoute(async (req, res) => {
  const clientID = await getClientIDFromParams(req.params.id);
  const member = await TeamMember.findOne({ _id: req.params.memberId, clientID });
  if (!member) return res.status(404).json({ error: 'Team member not found' });

  if (member.orgRole === 'owner') {
    return res.status(400).json({ error: 'Cannot remove the organization owner' });
  }

  await TeamMember.deleteOne({ _id: member._id });
  res.json({ success: true, message: 'Team member removed' });
}));

router.post('/clients/:id/team/:memberId/send-reset-password', requireAdmin, wrapRoute(async (req, res) => {
  const clientID = await getClientIDFromParams(req.params.id);
  try {
    const result = await issueTeamPasswordReset({
      clientID,
      memberId: req.params.memberId,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to send reset email' });
  }
}));

router.post('/clients/:id/team/send-owner-reset-password', requireAdmin, wrapRoute(async (req, res) => {
  const clientID = await getClientIDFromParams(req.params.id);
  const { email } = req.body;
  try {
    const result = await issueLegacyTeamPasswordReset({
      clientID,
      email,
      bypassEmailCheck: true,
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Failed to send owner setup reset email' });
  }
}));

module.exports = router;
