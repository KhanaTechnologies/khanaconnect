const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const B2BTier = require('../models/B2BTier');
const B2BBuyer = require('../models/B2BBuyer');
const B2BPriceList = require('../models/B2BPriceList');
const Warehouse = require('../models/Warehouse');
const WarehouseStock = require('../models/WarehouseStock');
const {
  findLowStockRows,
  checkWarehouseStockAlerts,
  sendAlertsForClient,
} = require('../helpers/b2bWarehouseAlerts');
const WarehouseLowStockAlert = require('../models/WarehouseLowStockAlert');
const B2BAuditLog = require('../models/B2BAuditLog');
const Product = require('../models/product');
const { Order } = require('../models/order');
const { OrderItem } = require('../models/orderItem');
const Client = require('../models/client');
const { wrapRoute } = require('../helpers/failureEmail');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
const { recordTeamActivityFromRequest } = require('../helpers/teamActivity');
const {
  buildB2BCatalog,
  calculateB2BLineItems,
} = require('../helpers/b2bPricing');
const {
  validateStorefrontClientToken,
  requireApprovedBuyer,
  signBuyerToken,
} = require('../helpers/b2bStorefrontAuth');
const { findB2BBuyerByEmail } = require('../helpers/b2bBuyerLookup');
const { sendOrderConfirmationEmail } = require('../utils/email');
const { sendB2BLoginCodeEmail } = require('../utils/sendB2BLoginCode');
const { clientEmailBrandingPayload } = require('../helpers/clientEmailBranding');
const { mergeB2bSettings } = require('../helpers/b2bDefaults');
const { buyerPortalStockSettings } = require('../helpers/b2bBuyerStockWarnings');
const {
  recordB2BAudit,
  isBuyerLocked,
  registerFailedLogin,
  clearFailedLogins,
  createLoginChallenge,
  verifyLoginChallenge,
} = require('../helpers/b2bSecurity');
const {
  isMultiWarehouseEnabled,
  getActiveWarehouses,
  upsertWarehouseStock,
  transferStock,
  allocateWarehouseStock,
  resolveFulfillmentWarehouse,
} = require('../helpers/warehouseInventory');

const router = express.Router();
const authenticateB2B = createDashboardAuth('b2b');

const b2bLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

const b2bOtpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { error: 'Too many verification attempts — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function publicBuyer(buyer) {
  const doc = buyer.toObject ? buyer.toObject() : buyer;
  delete doc.passwordHash;
  return doc;
}

// ─── Dashboard: settings & audit ────────────────────────────────────────────

router.get('/settings', authenticateB2B, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.clientId }).select('b2bSettings');
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json({ success: true, settings: mergeB2bSettings(client) });
}));

router.put('/settings', authenticateB2B, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.clientId });
  if (!client) return res.status(404).json({ error: 'Client not found' });
  if (!client.b2bSettings) client.b2bSettings = {};
  const allowed = Object.keys(mergeB2bSettings({}));
  for (const key of allowed) {
    if (req.body[key] !== undefined) client.b2bSettings[key] = req.body[key];
  }
  await client.save();
  res.json({ success: true, settings: mergeB2bSettings(client) });
}));

router.get('/audit-log', authenticateB2B, wrapRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const logs = await B2BAuditLog.find({ clientID: req.clientId })
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json({ success: true, logs });
}));

// ─── Dashboard: warehouse low-stock alerts ───────────────────────────────────

router.get('/warehouse-alerts', authenticateB2B, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.clientId }).select('b2bSettings');
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const settings = mergeB2bSettings(client);
  const alerts = await findLowStockRows(req.clientId, settings);
  res.json({
    success: true,
    alerts,
    summary: {
      total: alerts.length,
      outOfStock: alerts.filter((a) => a.severity === 'out').length,
      low: alerts.filter((a) => a.severity === 'low').length,
      pendingNotification: alerts.filter((a) => a.needsAlert).length,
    },
  });
}));

router.post('/warehouse-alerts/check', authenticateB2B, wrapRoute(async (req, res) => {
  const force = !!req.body.force;
  const result = await sendAlertsForClient(req.clientId, { force });
  res.json({ success: true, result });
}));

router.get('/warehouse-alerts/history', authenticateB2B, wrapRoute(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const filter = { clientID: req.clientId };
  if (req.query.warehouseId) filter.warehouseId = req.query.warehouseId;

  const history = await WarehouseLowStockAlert.find(filter)
    .populate('warehouseId', 'name code')
    .populate('productId', 'productName images')
    .sort({ createdAt: -1 })
    .limit(limit);

  res.json({ success: true, history });
}));

// ─── Dashboard: warehouses ────────────────────────────────────────────────────

router.get('/warehouses', authenticateB2B, wrapRoute(async (req, res) => {
  const warehouses = await Warehouse.find({ clientID: req.clientId }).sort({ priority: -1, name: 1 });
  res.json({ success: true, warehouses });
}));

router.post('/warehouses', authenticateB2B, wrapRoute(async (req, res) => {
  const { name, code, address, city, postalCode, phone, isDefault, priority, notes } = req.body;
  if (!name?.trim() || !code?.trim()) {
    return res.status(400).json({ error: 'Warehouse name and code are required' });
  }

  if (isDefault) {
    await Warehouse.updateMany({ clientID: req.clientId }, { isDefault: false });
  }

  const warehouse = await Warehouse.create({
    clientID: req.clientId,
    name: name.trim(),
    code: code.trim().toUpperCase(),
    address: address || '',
    city: city || '',
    postalCode: postalCode || '',
    phone: phone || '',
    isDefault: !!isDefault,
    priority: Number(priority) || 0,
    notes: notes || '',
  });

  res.status(201).json({ success: true, warehouse });
}));

router.put('/warehouses/:id', authenticateB2B, wrapRoute(async (req, res) => {
  const warehouse = await Warehouse.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!warehouse) return res.status(404).json({ error: 'Warehouse not found' });

  const fields = ['name', 'code', 'address', 'city', 'postalCode', 'phone', 'priority', 'notes', 'active'];
  for (const key of fields) {
    if (req.body[key] !== undefined) warehouse[key] = req.body[key];
  }
  if (req.body.code) warehouse.code = String(req.body.code).trim().toUpperCase();
  if (req.body.isDefault) {
    await Warehouse.updateMany({ clientID: req.clientId }, { isDefault: false });
    warehouse.isDefault = true;
  }

  await warehouse.save();
  res.json({ success: true, warehouse });
}));

router.get('/warehouses/:id/stock', authenticateB2B, wrapRoute(async (req, res) => {
  const stock = await WarehouseStock.find({
    clientID: req.clientId,
    warehouseId: req.params.id,
  })
    .populate('productId', 'productName price countInStock images')
    .sort({ updatedAt: -1 });

  res.json({ success: true, stock });
}));

router.put('/warehouses/:id/stock', authenticateB2B, wrapRoute(async (req, res) => {
  const warehouse = await Warehouse.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!warehouse) return res.status(404).json({ error: 'Warehouse not found' });

  const { productId, quantity, variant, reorderLevel } = req.body;
  if (!productId || quantity == null) {
    return res.status(400).json({ error: 'productId and quantity are required' });
  }

  const product = await Product.findOne({ _id: productId, clientID: req.clientId });
  if (!product) return res.status(404).json({ error: 'Product not found' });

  const row = await upsertWarehouseStock({
    clientID: req.clientId,
    warehouseId: warehouse._id,
    productId,
    variant: variant || null,
    quantity,
    reorderLevel,
  });

  res.json({ success: true, stock: row });
}));

router.post('/warehouses/transfer', authenticateB2B, wrapRoute(async (req, res) => {
  const { fromWarehouseId, toWarehouseId, productId, quantity, variant } = req.body;
  if (!fromWarehouseId || !toWarehouseId || !productId || !quantity) {
    return res.status(400).json({ error: 'fromWarehouseId, toWarehouseId, productId, and quantity are required' });
  }

  const result = await transferStock({
    clientID: req.clientId,
    fromWarehouseId,
    toWarehouseId,
    productId,
    variant: variant || null,
    quantity,
  });

  recordTeamActivityFromRequest(req, {
    category: 'orders',
    action: 'b2b.stock.transferred',
    summary: `Stock transfer ${quantity} units between warehouses`,
    metadata: { productId, fromWarehouseId, toWarehouseId },
  });

  res.json({ success: true, ...result });
}));

// ─── Dashboard: tiers ───────────────────────────────────────────────────────

router.get('/tiers', authenticateB2B, wrapRoute(async (req, res) => {
  const tiers = await B2BTier.find({ clientID: req.clientId }).sort({ sortOrder: 1, name: 1 });
  res.json({ success: true, tiers });
}));

router.post('/tiers', authenticateB2B, wrapRoute(async (req, res) => {
  const { name, description, sortOrder, active } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Tier name is required' });

  const tier = await B2BTier.create({
    clientID: req.clientId,
    name: name.trim(),
    slug: slugify(name),
    description: description || '',
    sortOrder: Number(sortOrder) || 0,
    active: active !== false,
  });

  res.status(201).json({ success: true, tier });
  recordTeamActivityFromRequest(req, {
    category: 'orders',
    action: 'b2b.tier.created',
    summary: `B2B tier "${tier.name}" created`,
    metadata: { tierId: String(tier._id) },
  });
}));

router.put('/tiers/:id', authenticateB2B, wrapRoute(async (req, res) => {
  const tier = await B2BTier.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!tier) return res.status(404).json({ error: 'Tier not found' });

  if (req.body.name?.trim()) {
    tier.name = req.body.name.trim();
    tier.slug = slugify(req.body.name);
  }
  if (req.body.description != null) tier.description = req.body.description;
  if (req.body.sortOrder != null) tier.sortOrder = Number(req.body.sortOrder) || 0;
  if (req.body.active != null) tier.active = !!req.body.active;

  await tier.save();
  res.json({ success: true, tier });
}));

router.delete('/tiers/:id', authenticateB2B, wrapRoute(async (req, res) => {
  const tier = await B2BTier.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
  if (!tier) return res.status(404).json({ error: 'Tier not found' });
  await B2BPriceList.deleteMany({ clientID: req.clientId, tierId: tier._id });
  res.json({ success: true, message: 'Tier deleted' });
}));

// ─── Dashboard: buyers ──────────────────────────────────────────────────────

router.get('/buyers', authenticateB2B, wrapRoute(async (req, res) => {
  const filter = { clientID: req.clientId };
  if (req.query.status) filter.status = req.query.status;

  const buyers = await B2BBuyer.find(filter)
    .populate('tierId', 'name slug')
    .sort({ createdAt: -1 });

  res.json({ success: true, buyers: buyers.map(publicBuyer) });
}));

router.post('/buyers', authenticateB2B, wrapRoute(async (req, res) => {
  const {
    companyName,
    tradingName,
    vatNumber,
    contactFirstName,
    contactLastName,
    email,
    phone,
    password,
    tierId,
    paymentTerms,
    canOrder,
    status,
    deliveryAddresses,
    internalNotes,
  } = req.body;

  if (!companyName || !contactFirstName || !contactLastName || !email || !tierId) {
    return res.status(400).json({ error: 'Company, contact, email, and tier are required' });
  }

  const tier = await B2BTier.findOne({ _id: tierId, clientID: req.clientId, active: true });
  if (!tier) return res.status(400).json({ error: 'Invalid tier' });

  const tempPassword = password || `Khana-${Math.random().toString(36).slice(2, 10)}`;
  const passwordHash = await bcrypt.hash(tempPassword, 10);

  const buyer = await B2BBuyer.create({
    clientID: req.clientId,
    companyName: companyName.trim(),
    tradingName: tradingName || '',
    vatNumber: vatNumber || '',
    contactFirstName: contactFirstName.trim(),
    contactLastName: contactLastName.trim(),
    email: email.trim().toLowerCase(),
    phone: phone || '',
    passwordHash,
    tierId,
    paymentTerms: paymentTerms || 'prepaid',
    canOrder: canOrder !== false,
    status: status || 'approved',
    approvedAt: status === 'approved' || !status ? new Date() : null,
    deliveryAddresses: Array.isArray(deliveryAddresses) ? deliveryAddresses : [],
    internalNotes: internalNotes || '',
  });

  res.status(201).json({
    success: true,
    buyer: publicBuyer(buyer),
    temporaryPassword: password ? undefined : tempPassword,
  });
}));

router.patch('/buyers/:id/approve', authenticateB2B, wrapRoute(async (req, res) => {
  const buyer = await B2BBuyer.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!buyer) return res.status(404).json({ error: 'Buyer not found' });

  buyer.status = 'approved';
  buyer.approvedAt = new Date();
  buyer.approvedBy = req.teamMemberId || null;
  if (req.body.paymentTerms) buyer.paymentTerms = req.body.paymentTerms;
  if (req.body.tierId) buyer.tierId = req.body.tierId;
  await buyer.save();

  res.json({ success: true, buyer: publicBuyer(buyer) });
}));

router.patch('/buyers/:id/reject', authenticateB2B, wrapRoute(async (req, res) => {
  const buyer = await B2BBuyer.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!buyer) return res.status(404).json({ error: 'Buyer not found' });
  buyer.status = 'rejected';
  await buyer.save();
  res.json({ success: true, buyer: publicBuyer(buyer) });
}));

router.put('/buyers/:id', authenticateB2B, wrapRoute(async (req, res) => {
  const buyer = await B2BBuyer.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!buyer) return res.status(404).json({ error: 'Buyer not found' });

  const fields = [
    'companyName',
    'tradingName',
    'vatNumber',
    'contactFirstName',
    'contactLastName',
    'phone',
    'tierId',
    'paymentTerms',
    'canOrder',
    'status',
    'internalNotes',
  ];
  for (const key of fields) {
    if (req.body[key] !== undefined) buyer[key] = req.body[key];
  }
  if (req.body.email) buyer.email = req.body.email.trim().toLowerCase();
  if (req.body.deliveryAddresses) buyer.deliveryAddresses = req.body.deliveryAddresses;
  if (req.body.password) buyer.passwordHash = await bcrypt.hash(req.body.password, 10);
  if (req.body.preferredWarehouseId !== undefined) buyer.preferredWarehouseId = req.body.preferredWarehouseId;
  if (req.body.allowedWarehouseIds) buyer.allowedWarehouseIds = req.body.allowedWarehouseIds;

  await buyer.save();
  res.json({ success: true, buyer: publicBuyer(buyer) });
}));

// ─── Dashboard: pricing ───────────────────────────────────────────────────────

router.get('/pricing', authenticateB2B, wrapRoute(async (req, res) => {
  const filter = { clientID: req.clientId };
  if (req.query.tierId) filter.tierId = req.query.tierId;
  if (req.query.productId) filter.productId = req.query.productId;

  const rows = await B2BPriceList.find(filter)
    .populate('tierId', 'name slug')
    .populate('productId', 'productName price')
    .sort({ tierId: 1, productId: 1, minQty: 1 });

  res.json({ success: true, pricing: rows });
}));

router.post('/pricing', authenticateB2B, wrapRoute(async (req, res) => {
  const { tierId, productId, price, minQty, active } = req.body;
  if (!tierId || !productId || price == null) {
    return res.status(400).json({ error: 'tierId, productId, and price are required' });
  }

  const [tier, product] = await Promise.all([
    B2BTier.findOne({ _id: tierId, clientID: req.clientId }),
    Product.findOne({ _id: productId, clientID: req.clientId }),
  ]);
  if (!tier || !product) return res.status(400).json({ error: 'Invalid tier or product' });

  const row = await B2BPriceList.findOneAndUpdate(
    { clientID: req.clientId, tierId, productId, minQty: Math.max(1, Number(minQty) || 1) },
    {
      clientID: req.clientId,
      tierId,
      productId,
      price: Number(price),
      minQty: Math.max(1, Number(minQty) || 1),
      active: active !== false,
    },
    { upsert: true, new: true }
  );

  res.status(201).json({ success: true, pricing: row });
}));

router.post('/pricing/bulk', authenticateB2B, wrapRoute(async (req, res) => {
  const { tierId, entries } = req.body;
  if (!tierId || !Array.isArray(entries) || !entries.length) {
    return res.status(400).json({ error: 'tierId and entries array are required' });
  }

  const tier = await B2BTier.findOne({ _id: tierId, clientID: req.clientId });
  if (!tier) return res.status(400).json({ error: 'Invalid tier' });

  const results = [];
  for (const entry of entries) {
    if (!entry.productId || entry.price == null) continue;
    const row = await B2BPriceList.findOneAndUpdate(
      {
        clientID: req.clientId,
        tierId,
        productId: entry.productId,
        minQty: Math.max(1, Number(entry.minQty) || 1),
      },
      {
        clientID: req.clientId,
        tierId,
        productId: entry.productId,
        price: Number(entry.price),
        minQty: Math.max(1, Number(entry.minQty) || 1),
        active: entry.active !== false,
      },
      { upsert: true, new: true }
    );
    results.push(row);
  }

  res.json({ success: true, count: results.length, pricing: results });
}));

router.delete('/pricing/:id', authenticateB2B, wrapRoute(async (req, res) => {
  const row = await B2BPriceList.findOneAndDelete({ _id: req.params.id, clientID: req.clientId });
  if (!row) return res.status(404).json({ error: 'Pricing row not found' });
  res.json({ success: true });
}));

// ─── Dashboard: B2B orders & stats ──────────────────────────────────────────

router.get('/orders', authenticateB2B, wrapRoute(async (req, res) => {
  const orders = await Order.find({ clientID: req.clientId, orderType: 'b2b' })
    .populate('b2bBuyer', 'companyName contactFirstName contactLastName email paymentTerms')
    .populate({
      path: 'orderItems',
      populate: { path: 'product', select: 'productName price images' },
    })
    .sort({ dateOrdered: -1 });

  res.json({ success: true, orders });
}));

router.get('/stats', authenticateB2B, wrapRoute(async (req, res) => {
  const [pendingBuyers, approvedBuyers, b2bOrders, pricingRows, warehouseCount] = await Promise.all([
    B2BBuyer.countDocuments({ clientID: req.clientId, status: 'pending' }),
    B2BBuyer.countDocuments({ clientID: req.clientId, status: 'approved' }),
    Order.countDocuments({ clientID: req.clientId, orderType: 'b2b' }),
    B2BPriceList.countDocuments({ clientID: req.clientId, active: true }),
    Warehouse.countDocuments({ clientID: req.clientId, active: true }),
  ]);

  res.json({
    success: true,
    stats: { pendingBuyers, approvedBuyers, b2bOrders, pricingRows, warehouseCount },
  });
}));

// ─── Buyer portal (storefront) ────────────────────────────────────────────────

router.get('/portal/config', validateStorefrontClientToken, wrapRoute(async (req, res) => {
  res.json({
    success: true,
    clientID: req.clientID,
    companyName: req.storefrontClient.companyName || req.clientID,
  });
}));

router.get('/portal/tiers', validateStorefrontClientToken, wrapRoute(async (req, res) => {
  const tiers = await B2BTier.find({ clientID: req.clientID, active: true })
    .sort({ sortOrder: 1, name: 1 })
    .select('name slug description sortOrder');
  res.json({ success: true, tiers });
}));

router.post('/portal/register', validateStorefrontClientToken, wrapRoute(async (req, res) => {
  const {
    companyName,
    tradingName,
    vatNumber,
    contactFirstName,
    contactLastName,
    email,
    phone,
    password,
    tierId,
    deliveryAddresses,
  } = req.body;

  if (!companyName || !contactFirstName || !contactLastName || !email || !password) {
    return res.status(400).json({ error: 'Company, contact, email, and password are required' });
  }

  let resolvedTierId = tierId;
  if (!resolvedTierId) {
    const defaultTier = await B2BTier.findOne({ clientID: req.clientID, active: true }).sort({
      sortOrder: 1,
    });
    if (!defaultTier) {
      return res.status(400).json({ error: 'B2B is not configured yet — no pricing tier available' });
    }
    resolvedTierId = defaultTier._id;
  }

  const exists = await findB2BBuyerByEmail(B2BBuyer, req.clientID, email);
  if (exists) return res.status(409).json({ error: 'A buyer account with this email already exists' });

  const passwordHash = await bcrypt.hash(password, 10);
  const buyer = await B2BBuyer.create({
    clientID: req.clientID,
    companyName: companyName.trim(),
    tradingName: tradingName || '',
    vatNumber: vatNumber || '',
    contactFirstName: contactFirstName.trim(),
    contactLastName: contactLastName.trim(),
    email: email.trim().toLowerCase(),
    phone: phone || '',
    passwordHash,
    tierId: resolvedTierId,
    status: 'pending',
    deliveryAddresses: Array.isArray(deliveryAddresses) ? deliveryAddresses : [],
  });

  res.status(201).json({
    success: true,
    message: 'Application submitted. You will be notified once approved.',
    buyer: publicBuyer(buyer),
  });
}));

router.post('/portal/login', b2bLoginLimiter, validateStorefrontClientToken, wrapRoute(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const client = await Client.findOne({ clientID: req.clientID }).select(
    'clientID companyName businessEmail businessEmailPassword b2bSettings smtpHost smtpPort'
  );
  const settings = mergeB2bSettings(client);

  const buyer = await findB2BBuyerByEmail(B2BBuyer, req.clientID, email);

  if (!buyer) {
    await recordB2BAudit({
      clientID: req.clientID,
      event: 'login_failed',
      summary: 'Unknown B2B email attempted login',
      req,
      metadata: { email: email.trim().toLowerCase() },
    });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (isBuyerLocked(buyer, settings)) {
    return res.status(423).json({
      error: 'Account temporarily locked due to failed login attempts',
      lockedUntil: buyer.lockedUntil,
    });
  }

  if (buyer.status === 'rejected') return res.status(403).json({ error: 'Account application was not approved' });
  if (buyer.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

  const ok = await bcrypt.compare(password, buyer.passwordHash);
  if (!ok) {
    await registerFailedLogin(buyer, settings);
    await recordB2BAudit({
      clientID: req.clientID,
      buyerId: buyer._id,
      event: 'login_failed',
      summary: 'Invalid B2B password',
      req,
    });
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  await clearFailedLogins(buyer);

  if (settings.requireTwoFactor) {
    const { challenge, code, expiresAt } = await createLoginChallenge({ buyer, client, req });
    try {
      await sendB2BLoginCodeEmail({
        buyer,
        client,
        code,
        expiresMinutes: settings.otpExpiryMinutes,
      });
    } catch (err) {
      console.error('B2B OTP email failed:', err.message);
      return res.status(503).json({ error: 'Could not send verification code — try again shortly' });
    }

    await recordB2BAudit({
      clientID: req.clientID,
      buyerId: buyer._id,
      event: 'otp_sent',
      summary: 'B2B login verification code sent',
      req,
    });

    return res.json({
      success: true,
      requiresVerification: true,
      challengeId: String(challenge._id),
      expiresAt,
      message: 'Verification code sent to your registered email',
      approved: buyer.status === 'approved',
    });
  }

  buyer.lastLoginAt = new Date();
  await buyer.save();
  const token = signBuyerToken(buyer, client, { verified: true });

  await recordB2BAudit({
    clientID: req.clientID,
    buyerId: buyer._id,
    event: 'login_success',
    summary: 'B2B login completed (2FA disabled)',
    req,
  });

  res.json({
    success: true,
    token,
    buyer: publicBuyer(buyer),
    approved: buyer.status === 'approved',
  });
}));

router.post('/portal/verify-login', b2bOtpLimiter, validateStorefrontClientToken, wrapRoute(async (req, res) => {
  const { challengeId, code, email } = req.body;
  if (!challengeId || !code || !email) {
    return res.status(400).json({ error: 'challengeId, code, and email are required' });
  }

  const buyer = await findB2BBuyerByEmail(B2BBuyer, req.clientID, email);
  if (!buyer) return res.status(401).json({ error: 'Invalid verification session' });

  const result = await verifyLoginChallenge({
    challengeId,
    code,
    buyerId: buyer._id,
    clientID: req.clientID,
  });

  if (!result.ok) {
    await recordB2BAudit({
      clientID: req.clientID,
      buyerId: buyer._id,
      event: 'otp_failed',
      summary: result.error,
      req,
    });
    return res.status(401).json({ error: result.error });
  }

  const client = await Client.findOne({ clientID: req.clientID }).select('b2bSettings clientID');
  buyer.lastLoginAt = new Date();
  await buyer.save();

  const token = signBuyerToken(buyer, client, { verified: true });

  await recordB2BAudit({
    clientID: req.clientID,
    buyerId: buyer._id,
    event: 'login_success',
    summary: 'B2B login completed after 2FA',
    req,
  });

  res.json({
    success: true,
    token,
    buyer: publicBuyer(buyer),
    approved: buyer.status === 'approved',
  });
}));

router.get('/portal/me', requireApprovedBuyer, wrapRoute(async (req, res) => {
  const buyer = await B2BBuyer.findById(req.buyer._id)
    .populate('tierId', 'name slug description')
    .populate('preferredWarehouseId', 'name code');
  const client = await Client.findOne({ clientID: req.clientID }).select('b2bSettings');
  res.json({
    success: true,
    buyer: publicBuyer(buyer),
    settings: {
      multiWarehouseEnabled: isMultiWarehouseEnabled(client),
      allowBuyerWarehouseChoice: mergeB2bSettings(client).allowBuyerWarehouseChoice,
      ...buyerPortalStockSettings(client),
    },
  });
}));

router.get('/portal/warehouses', requireApprovedBuyer, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.clientID }).select('b2bSettings');
  if (!isMultiWarehouseEnabled(client)) {
    return res.json({ success: true, warehouses: [], multiWarehouseEnabled: false });
  }
  const warehouses = await getActiveWarehouses(req.clientID, {
    buyerAllowedIds: req.buyer.allowedWarehouseIds?.length ? req.buyer.allowedWarehouseIds : null,
  });
  res.json({ success: true, warehouses, multiWarehouseEnabled: true });
}));

router.get('/portal/catalog', requireApprovedBuyer, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.clientID }).select('b2bSettings clientID');
  const catalog = await buildB2BCatalog({
    clientID: req.clientID,
    tierId: req.buyer.tierId,
    buyer: req.buyer,
    warehouseId: req.query.warehouseId || null,
  });
  res.json({
    success: true,
    products: catalog,
    multiWarehouseEnabled: isMultiWarehouseEnabled(client),
    warehouseId: req.query.warehouseId || null,
    ...buyerPortalStockSettings(client),
  });
}));

router.post('/portal/quote', requireApprovedBuyer, wrapRoute(async (req, res) => {
  const { items, warehouseId } = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items array is required' });
  }

  const client = await Client.findOne({ clientID: req.clientID }).select('b2bSettings clientID');
  const { lines, subtotal } = await calculateB2BLineItems({
    clientID: req.clientID,
    tierId: req.buyer.tierId,
    items,
    client,
    buyer: req.buyer,
    warehouseId: warehouseId || null,
  });

  res.json({
    success: true,
    lines,
    subtotal,
    warehouseId: warehouseId || null,
    ...buyerPortalStockSettings(client),
  });
}));

router.post('/portal/orders', requireApprovedBuyer, wrapRoute(async (req, res) => {
  const {
    items,
    address,
    postalCode,
    phone,
    deliveryType,
    deliveryPrice = 0,
    poNumber,
    orderNotes,
    warehouseId,
  } = req.body;

  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'items array is required' });
  }
  if (!address || !postalCode || !phone) {
    return res.status(400).json({ error: 'Delivery address, postal code, and phone are required' });
  }

  const client = await Client.findOne({ clientID: req.clientID }).select(
    'b2bSettings clientID businessEmail businessEmailPassword companyName emailSignature smtpHost smtpPort'
  );
  const multiWarehouse = isMultiWarehouseEnabled(client);
  const settings = mergeB2bSettings(client);

  if (multiWarehouse && warehouseId && !settings.allowBuyerWarehouseChoice) {
    return res.status(403).json({ error: 'Warehouse selection is not allowed for your account' });
  }

  const { lines, subtotal } = await calculateB2BLineItems({
    clientID: req.clientID,
    tierId: req.buyer.tierId,
    items,
    client,
    buyer: req.buyer,
    warehouseId: multiWarehouse ? warehouseId || null : null,
  });

  let fulfillmentWarehouse = null;
  if (multiWarehouse) {
    fulfillmentWarehouse = await resolveFulfillmentWarehouse({
      client,
      buyer: req.buyer,
      items: lines,
      requestedWarehouseId: warehouseId || null,
    });
  }

  const orderItemIds = await Promise.all(
    lines.map(async (line) => {
      const orderItem = new OrderItem({
        product: line.product,
        quantity: line.quantity,
        variant: line.variant,
        variantPrice: line.variantPrice,
      });
      await orderItem.save();
      return orderItem._id;
    })
  );

  const delivery = Number(deliveryPrice) || 0;
  const finalPrice = subtotal + delivery;
  const paymentTerms = req.buyer.paymentTerms || 'prepaid';
  const requiresPrepay = paymentTerms === 'prepaid';

  const order = new Order({
    orderItems: orderItemIds,
    address,
    postalCode,
    phone,
    deliveryType: deliveryType || 'delivery',
    deliveryPrice: delivery,
    status: requiresPrepay ? 'Pending Payment' : 'Pending',
    totalPrice: subtotal,
    discountAmount: 0,
    finalPrice,
    clientID: req.clientID,
    orderNotes: orderNotes || '',
    orderType: 'b2b',
    paymentTerms,
    poNumber: poNumber || '',
    b2bBuyer: req.buyer._id,
    paid: !requiresPrepay,
    warehouseId: fulfillmentWarehouse?._id || null,
    stockSource: multiWarehouse ? 'warehouse' : 'legacy',
  });

  await order.save();

  if (multiWarehouse && fulfillmentWarehouse) {
    await allocateWarehouseStock({
      clientID: req.clientID,
      warehouseId: fulfillmentWarehouse._id,
      lines,
    });
  } else {
    for (const line of lines) {
      const product = await Product.findById(line.product);
      if (product) {
        product.countInStock = Math.max(0, (product.countInStock || 0) - line.quantity);
        await product.save();
      }
    }
  }

  if (client && req.buyer.notifications?.orderUpdates !== false) {
    try {
      await sendOrderConfirmationEmail(
        req.buyer.email,
        lines.map((l) => ({
          product: { productName: l.productName },
          quantity: l.quantity,
          variantPrice: l.unitPrice,
        })),
        client.businessEmail,
        client.businessEmailPassword,
        delivery,
        req.clientID,
        order._id,
        client.emailSignature || '',
        clientEmailBrandingPayload(client),
        req.clientID
      );
    } catch (err) {
      console.error('B2B order confirmation email failed:', err.message);
    }
  }

  await recordB2BAudit({
    clientID: req.clientID,
    buyerId: req.buyer._id,
    event: 'order_created',
    summary: `B2B order ${order._id} placed`,
    req,
    metadata: {
      orderId: String(order._id),
      warehouseId: fulfillmentWarehouse ? String(fulfillmentWarehouse._id) : null,
      total: finalPrice,
    },
  });

  res.status(201).json({
    success: true,
    order,
    warehouse: fulfillmentWarehouse
      ? { id: fulfillmentWarehouse._id, name: fulfillmentWarehouse.name, code: fulfillmentWarehouse.code }
      : null,
  });
}));

router.get('/portal/orders', requireApprovedBuyer, wrapRoute(async (req, res) => {
  const orders = await Order.find({ clientID: req.clientID, b2bBuyer: req.buyer._id, orderType: 'b2b' })
    .populate({
      path: 'orderItems',
      populate: { path: 'product', select: 'productName price images' },
    })
    .sort({ dateOrdered: -1 });

  res.json({ success: true, orders });
}));

router.get('/portal/orders/:id', requireApprovedBuyer, wrapRoute(async (req, res) => {
  const order = await Order.findOne({
    _id: req.params.id,
    clientID: req.clientID,
    b2bBuyer: req.buyer._id,
    orderType: 'b2b',
  }).populate({
    path: 'orderItems',
    populate: { path: 'product', select: 'productName price images' },
  });

  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ success: true, order });
}));

router.put('/portal/settings', requireApprovedBuyer, wrapRoute(async (req, res) => {
  const buyer = req.buyer;
  if (req.body.companyName) buyer.companyName = req.body.companyName;
  if (req.body.tradingName != null) buyer.tradingName = req.body.tradingName;
  if (req.body.vatNumber != null) buyer.vatNumber = req.body.vatNumber;
  if (req.body.phone != null) buyer.phone = req.body.phone;
  if (req.body.deliveryAddresses) buyer.deliveryAddresses = req.body.deliveryAddresses;
  if (req.body.notifications) buyer.notifications = { ...buyer.notifications, ...req.body.notifications };
  if (req.body.password) buyer.passwordHash = await bcrypt.hash(req.body.password, 10);
  await buyer.save();
  res.json({ success: true, buyer: publicBuyer(buyer) });
}));

module.exports = router;
