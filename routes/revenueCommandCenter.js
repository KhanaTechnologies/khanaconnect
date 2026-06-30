const express = require('express');
const jwt = require('jsonwebtoken');
const Client = require('../models/client');
const Customer = require('../models/customer');
const CustomerSegment = require('../models/CustomerSegment');
const ProductBundle = require('../models/ProductBundle');
const Product = require('../models/product');
const Campaign = require('../models/Campaign');
const PreorderPledge = require('../models/PreorderPledge');
const { wrapRoute } = require('../helpers/failureEmail');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
const { mergeRevenueSettings, DEFAULT_REVENUE_SETTINGS } = require('../helpers/revenueDefaults');
const {
  buildOverview,
  getAbandonedCarts,
  getDiscountAttribution,
  getInventoryOpportunities,
  getBookingOpportunities,
  resolveSegmentCustomers,
  getSocialProofFeed,
} = require('../helpers/revenueCommandCenter');
const { sendCartReminderEmail } = require('../utils/cartReminderEmail');
const { sendPreorderGoLiveEmail } = require('../helpers/preorderGoLiveEmail');
const { resolveSmtpHost } = require('../helpers/mailHost');
const { smtpErrorToHttp } = require('../helpers/smtpErrors');
const DiscountCode = require('../models/discountCode');
const { getPlaybooksForClient, runPlaybook } = require('../helpers/revenuePlaybooks');
const {
  getCartRecoveryStats,
  getCampaignAttribution,
  getAbandonedBookings,
} = require('../helpers/revenueMetrics');
const { getProfitView } = require('../helpers/revenueProfit');
const { getBackInStockOpportunities } = require('../helpers/revenueBackInStock');
const { sendManualRestockAlerts } = require('../services/wishlistNotifyService');

const router = express.Router();

const authenticateClient = createDashboardAuth('sales');

async function loadClient(clientId) {
  return Client.findOne({ clientID: clientId });
}

// ─── Overview (Revenue Command Center) ───
router.get('/overview', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const overview = await buildOverview(req.clientId, client);
  res.json({ success: true, ...overview });
}));

// ─── Settings ───
router.get('/settings', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  const { resolveRevenueCapabilities, effectiveBusinessType } = require('../helpers/revenueCapabilities');
  const settings = mergeRevenueSettings(client.revenueSettings);
  const capabilities = resolveRevenueCapabilities(client);
  res.json({
    success: true,
    settings: { ...settings, businessType: effectiveBusinessType(settings, capabilities) },
    capabilities,
  });
}));

router.put('/settings', authenticateClient, wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.clientId });
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const allowed = Object.keys(DEFAULT_REVENUE_SETTINGS);
  let changed = false;

  if (!client.revenueSettings || typeof client.revenueSettings !== 'object') {
    client.revenueSettings = { ...DEFAULT_REVENUE_SETTINGS };
  }

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      client.revenueSettings[key] = req.body[key];
      changed = true;
    }
  }

  if (!changed) {
    return res.status(400).json({ error: 'No valid settings provided' });
  }

  client.markModified('revenueSettings');
  await client.save();

  res.json({
    success: true,
    settings: mergeRevenueSettings(client.revenueSettings),
    capabilities: require('../helpers/revenueCapabilities').resolveRevenueCapabilities(client),
  });
}));

// ─── Cart recovery ───
router.get('/cart-recovery', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  const caps = require('../helpers/revenueCapabilities').resolveRevenueCapabilities(client);
  if (!caps.orders) {
    return res.json({ success: true, enabled: false, carts: [], reason: 'orders_permission_required' });
  }
  if (!settings.cartRecoveryEnabled) {
    return res.json({ success: true, enabled: false, carts: [] });
  }
  const carts = await getAbandonedCarts(req.clientId, 100);
  res.json({ success: true, enabled: true, carts });
}));

router.post('/cart-recovery/:customerId/send', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  if (!settings.cartRecoveryEnabled) {
    return res.status(400).json({ error: 'Cart recovery is disabled in Revenue settings' });
  }
  if (!client || !resolveSmtpHost(client)) {
    return res.status(400).json({ error: 'Configure business email / SMTP first' });
  }

  const customer = await Customer.findOne({ _id: req.params.customerId, clientID: req.clientId });
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!customer.cart?.length) return res.status(400).json({ error: 'Cart is empty' });

  try {
    await sendCartReminderEmail(customer, client);
  } catch (err) {
    throw smtpErrorToHttp(err);
  }

  customer.cartReminder = customer.cartReminder || {};
  customer.cartReminder.lastSent = new Date();
  await customer.save();

  res.json({ success: true, message: 'Cart reminder sent' });
}));

router.post('/cart-recovery/bulk-send', authenticateClient, wrapRoute(async (req, res) => {
  const { customerIds = [] } = req.body;
  if (!Array.isArray(customerIds) || !customerIds.length) {
    return res.status(400).json({ error: 'customerIds array required' });
  }

  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  if (!settings.cartRecoveryEnabled) {
    return res.status(400).json({ error: 'Cart recovery is disabled' });
  }
  if (!client || !resolveSmtpHost(client)) {
    return res.status(400).json({ error: 'Configure SMTP first' });
  }

  let sent = 0;
  let failed = 0;
  for (const id of customerIds.slice(0, 25)) {
    try {
      const customer = await Customer.findOne({ _id: id, clientID: req.clientId });
      if (!customer?.cart?.length) continue;
      await sendCartReminderEmail(customer, client);
      customer.cartReminder = customer.cartReminder || {};
      customer.cartReminder.lastSent = new Date();
      await customer.save();
      sent += 1;
    } catch (_e) {
      failed += 1;
    }
  }

  res.json({ success: true, sent, failed });
}));

// ─── Revenue playbooks (one-click actions) ───
router.get('/playbooks', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  res.json({ success: true, playbooks: getPlaybooksForClient(client) });
}));

router.post('/playbooks/:playbookId/run', authenticateClient, wrapRoute(async (req, res) => {
  const { limit } = req.body || {};
  try {
    const result = await runPlaybook(req.clientId, req.params.playbookId, { limit });
    res.json(result);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
}));

// ─── Cart recovery metrics ───
router.get('/metrics/cart-recovery', authenticateClient, wrapRoute(async (req, res) => {
  const stats = await getCartRecoveryStats(req.clientId);
  res.json({ success: true, ...stats });
}));

// ─── Campaign attribution ───
router.get('/campaign-attribution', authenticateClient, wrapRoute(async (req, res) => {
  const rows = await getCampaignAttribution(req.clientId, 20);
  res.json({ success: true, rows });
}));

// ─── Booking abandonment preview ───
router.get('/booking-abandonment', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  const caps = require('../helpers/revenueCapabilities').resolveRevenueCapabilities(client);
  if (!caps.bookings) {
    return res.json({ success: true, enabled: false, bookings: [] });
  }
  const bookings = await getAbandonedBookings(req.clientId, 50);
  res.json({
    success: true,
    enabled: settings.bookingAbandonmentEnabled,
    bookings,
  });
}));

// ─── Referral codes ───
router.get('/referrals/customers', authenticateClient, wrapRoute(async (req, res) => {
  const search = String(req.query.search || '').trim().toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 50, 100);

  let customers = await Customer.find({ clientID: req.clientId })
    .select('customerFirstName customerLastName emailAddress totalOrders lastActivity')
    .sort({ lastActivity: -1 })
    .limit(search ? 400 : limit);

  if (search) {
    customers = customers
      .filter((c) => {
        const name = `${c.customerFirstName || ''} ${c.customerLastName || ''}`.toLowerCase();
        const email = String(c.emailAddress || '').toLowerCase();
        return name.includes(search) || email.includes(search);
      })
      .slice(0, limit);
  }

  res.json({
    success: true,
    customers: customers.map((c) => ({
      id: c._id,
      name:
        `${c.customerFirstName || ''} ${c.customerLastName || ''}`.trim() || 'Customer',
      email: c.emailAddress,
      totalOrders: c.totalOrders || 0,
      lastActivity: c.lastActivity,
    })),
  });
}));

router.get('/referrals', authenticateClient, wrapRoute(async (req, res) => {
  const codes = await DiscountCode.find({
    clientID: req.clientId,
    isReferral: true,
  })
    .sort({ updatedAt: -1 })
    .populate('referrerCustomerId', 'customerFirstName customerLastName emailAddress');

  const attribution = await getDiscountAttribution(req.clientId);
  const byCode = Object.fromEntries(attribution.map((r) => [r.code, r]));

  res.json({
    success: true,
    referrals: codes.map((c) => ({
      id: c._id,
      code: c.code,
      discount: c.discount,
      usageCount: c.usageCount,
      usageLimit: c.usageLimit,
      isActive: c.isActive,
      referrer: c.referrerCustomerId
        ? {
            id: c.referrerCustomerId._id,
            name: `${c.referrerCustomerId.customerFirstName || ''} ${c.referrerCustomerId.customerLastName || ''}`.trim(),
            email: c.referrerCustomerId.emailAddress,
          }
        : null,
      referrerLabel: c.referrerLabel || '',
      revenue: byCode[c.code]?.revenue || 0,
      orderCount: byCode[c.code]?.orderCount || 0,
    })),
  });
}));

router.post('/referrals', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  if (!settings.referralCodesEnabled) {
    return res.status(400).json({ error: 'Referral codes are disabled in Revenue settings' });
  }

  const { customerId, discount = 10, usageLimit = 50, referrerLabel = '' } = req.body;
  if (!customerId) return res.status(400).json({ error: 'customerId required' });

  const customer = await Customer.findOne({ _id: customerId, clientID: req.clientId });
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const existing = await DiscountCode.findOne({
    clientID: req.clientId,
    isReferral: true,
    referrerCustomerId: customer._id,
    isActive: true,
  });
  if (existing) {
    return res.json({ success: true, referral: existing, created: false });
  }

  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const base = (customer.customerFirstName || 'REF').slice(0, 4).toUpperCase().replace(/[^A-Z]/g, '') || 'REF';
  const code = `${base}${suffix}`;

  const referral = await DiscountCode.create({
    id: `ref${Date.now()}`,
    code,
    discount: Number(discount) || 10,
    type: 'all',
    appliesTo: [],
    appliesToModel: 'Product',
    usageLimit: Number(usageLimit) || 50,
    clientID: req.clientId,
    isActive: true,
    isReferral: true,
    referrerCustomerId: customer._id,
    referrerLabel: referrerLabel || `${customer.customerFirstName || ''} ${customer.customerLastName || ''}`.trim(),
  });

  res.status(201).json({ success: true, referral, created: true });
}));

// ─── Profit view ───
router.get('/profit', authenticateClient, wrapRoute(async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 0), 365);
  const profit = await getProfitView(req.clientId, days);
  res.json({ success: true, profit });
}));

// ─── Back-in-stock alerts ───
router.get('/back-in-stock', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  const caps = require('../helpers/revenueCapabilities').resolveRevenueCapabilities(client);
  if (!caps.products) {
    return res.json({ success: true, enabled: false, products: [], summary: {} });
  }
  const data = await getBackInStockOpportunities(req.clientId);
  res.json({
    success: true,
    enabled: settings.backInStockAlertsEnabled,
    ...data,
  });
}));

router.post('/back-in-stock/:productId/notify', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  if (!settings.backInStockAlertsEnabled) {
    return res.status(400).json({ error: 'Back-in-stock alerts are disabled in Revenue settings' });
  }
  if (!resolveSmtpHost(client)) {
    return res.status(400).json({ error: 'Configure business email / SMTP first' });
  }

  const { force } = req.body || {};
  const result = await sendManualRestockAlerts(req.clientId, req.params.productId, {
    force: force === true || force === 'true',
  });

  if (result.error === 'product_not_found') {
    return res.status(404).json({ error: 'Product not found' });
  }
  if (result.error === 'out_of_stock') {
    return res.status(400).json({ error: 'Product is out of stock — update stock first' });
  }
  if (result.error === 'smtp_not_configured') {
    return res.status(400).json({ error: 'Configure SMTP first' });
  }

  res.json({ success: true, ...result });
}));

// ─── Discount attribution ───
router.get('/discount-attribution', authenticateClient, wrapRoute(async (req, res) => {
  const rows = await getDiscountAttribution(req.clientId);
  res.json({ success: true, rows });
}));

// ─── Inventory opportunities ───
router.get('/inventory-opportunities', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  const items = await getInventoryOpportunities(req.clientId, settings);
  res.json({ success: true, enabled: settings.inventoryPromosEnabled, items });
}));

// ─── Booking optimizer ───
router.get('/booking-opportunities', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  const caps = require('../helpers/revenueCapabilities').resolveRevenueCapabilities(client);
  if (!caps.bookings) {
    return res.json({ success: true, enabled: false, items: [], reason: 'bookings_permission_required' });
  }
  const items = await getBookingOpportunities(req.clientId, settings);
  res.json({ success: true, enabled: settings.bookingOptimizerEnabled, items });
}));

// ─── Customer segments ───
router.get('/segments', authenticateClient, wrapRoute(async (req, res) => {
  const segments = await CustomerSegment.find({ clientID: req.clientId }).sort({ updatedAt: -1 });
  const withCounts = await Promise.all(
    segments.map(async (s) => {
      const members = await resolveSegmentCustomers(req.clientId, s);
      return {
        ...s.toObject(),
        memberCount: members.length,
      };
    })
  );
  res.json({ success: true, segments: withCounts });
}));

router.post('/segments', authenticateClient, wrapRoute(async (req, res) => {
  const { name, description, preset } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const segment = await CustomerSegment.create({
    clientID: req.clientId,
    name: name.trim(),
    description: description || '',
    preset: preset || 'custom',
  });
  res.status(201).json({ success: true, segment });
}));

router.put('/segments/:id', authenticateClient, wrapRoute(async (req, res) => {
  const segment = await CustomerSegment.findOneAndUpdate(
    { _id: req.params.id, clientID: req.clientId },
    {
      ...(req.body.name !== undefined && { name: req.body.name }),
      ...(req.body.description !== undefined && { description: req.body.description }),
      ...(req.body.preset !== undefined && { preset: req.body.preset }),
      ...(req.body.isActive !== undefined && { isActive: req.body.isActive }),
    },
    { new: true }
  );
  if (!segment) return res.status(404).json({ error: 'Segment not found' });
  res.json({ success: true, segment });
}));

router.delete('/segments/:id', authenticateClient, wrapRoute(async (req, res) => {
  const result = await CustomerSegment.deleteOne({ _id: req.params.id, clientID: req.clientId });
  if (!result.deletedCount) return res.status(404).json({ error: 'Segment not found' });
  res.json({ success: true });
}));

router.get('/segments/:id/preview', authenticateClient, wrapRoute(async (req, res) => {
  const segment = await CustomerSegment.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!segment) return res.status(404).json({ error: 'Segment not found' });
  const members = await resolveSegmentCustomers(req.clientId, segment);
  res.json({
    success: true,
    memberCount: members.length,
    sample: members.slice(0, 10).map((c) => ({
      id: c._id,
      email: c.emailAddress,
      name: `${c.customerFirstName || ''} ${c.customerLastName || ''}`.trim(),
    })),
  });
}));

router.get('/segments/presets/list', authenticateClient, (_req, res) => {
  res.json({
    success: true,
    presets: [
      { id: 'cart_abandoned', label: 'Abandoned cart', description: 'Has items in cart, idle 24h+' },
      { id: 'wishlist_savers', label: 'Wishlist savers', description: 'Saved products but may not have bought' },
      { id: 'high_value', label: 'High-value customers', description: 'Spent R500+' },
      { id: 'inactive_60', label: 'Inactive 60 days', description: 'No recent activity' },
      { id: 'product_buyers', label: 'Product buyers', description: 'At least one order' },
      { id: 'service_bookers', label: 'Repeat bookers', description: 'Customers with order history' },
    ],
  });
});

// ─── Bundles & upsells ───
router.get('/bundles', authenticateClient, wrapRoute(async (req, res) => {
  const bundles = await ProductBundle.find({ clientID: req.clientId }).sort({ updatedAt: -1 });
  res.json({ success: true, bundles });
}));

router.post('/bundles', authenticateClient, wrapRoute(async (req, res) => {
  const { name, description, items, bundlePrice, discountPercent, showAtCheckout, imageUrl } = req.body;
  if (!name?.trim() || !Array.isArray(items) || items.length < 2) {
    return res.status(400).json({ error: 'name and at least 2 items required' });
  }
  const bundle = await ProductBundle.create({
    clientID: req.clientId,
    name: name.trim(),
    description: description || '',
    items,
    bundlePrice,
    discountPercent: discountPercent ?? 10,
    showAtCheckout: showAtCheckout !== false,
    imageUrl: imageUrl || '',
  });
  res.status(201).json({ success: true, bundle });
}));

router.put('/bundles/:id', authenticateClient, wrapRoute(async (req, res) => {
  const bundle = await ProductBundle.findOneAndUpdate(
    { _id: req.params.id, clientID: req.clientId },
    { $set: req.body },
    { new: true, runValidators: true }
  );
  if (!bundle) return res.status(404).json({ error: 'Bundle not found' });
  res.json({ success: true, bundle });
}));

router.delete('/bundles/:id', authenticateClient, wrapRoute(async (req, res) => {
  const result = await ProductBundle.deleteOne({ _id: req.params.id, clientID: req.clientId });
  if (!result.deletedCount) return res.status(404).json({ error: 'Bundle not found' });
  res.json({ success: true });
}));

/** Public/active bundles for checkout upsell */
router.get('/bundles/active/list', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  if (!settings.bundleUpsellsEnabled) {
    return res.json({ success: true, enabled: false, bundles: [] });
  }
  const bundles = await ProductBundle.find({
    clientID: req.clientId,
    isActive: true,
    showAtCheckout: true,
  });
  res.json({ success: true, enabled: true, bundles });
}));

router.post('/bundles/verify-cart', authenticateClient, wrapRoute(async (req, res) => {
  const { cartProductIds = [] } = req.body;
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  if (!settings.bundleUpsellsEnabled) {
    return res.json({ success: true, suggestions: [] });
  }

  const bundles = await ProductBundle.find({
    clientID: req.clientId,
    isActive: true,
    showAtCheckout: true,
  });

  const cartSet = new Set(cartProductIds.map(String));
  const suggestions = [];

  for (const b of bundles) {
    const productItems = b.items.filter((i) => i.itemType === 'product');
    const ids = productItems.map((i) => String(i.itemId));
    const hasSome = ids.some((id) => cartSet.has(id));
    const hasAll = ids.every((id) => cartSet.has(id));
    if (hasSome && !hasAll) {
      const missing = ids.filter((id) => !cartSet.has(id));
      suggestions.push({
        bundleId: b._id,
        name: b.name,
        discountPercent: b.discountPercent,
        bundlePrice: b.bundlePrice,
        missingProductIds: missing,
        message: `Add ${missing.length} more item(s) to unlock the "${b.name}" bundle`,
      });
    }
  }

  res.json({ success: true, suggestions });
}));

// ─── Preorder go-live blast (manual button) ───
router.post('/preorder/:campaignId/go-live', authenticateClient, wrapRoute(async (req, res) => {
  const { subject, message, orderUrl, confirmLive } = req.body;

  if (confirmLive !== true && confirmLive !== 'true') {
    return res.status(400).json({
      error: 'confirmLive must be true — use this only when the product/campaign is really live',
    });
  }

  const campaign = await Campaign.findOne({
    _id: req.params.campaignId,
    clientId: req.clientId,
    isDeleted: { $ne: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const client = await loadClient(req.clientId);
  if (!client || !resolveSmtpHost(client)) {
    return res.status(400).json({ error: 'Configure business email / SMTP first' });
  }

  const signups = await PreorderPledge.find({
    campaignId: campaign._id,
    isDeleted: { $ne: true },
    'communicationPreferences.emailUpdates': { $ne: false },
  });

  const defaultMessage =
    message?.trim() ||
    `Great news — ${campaign.name} is officially live! You can order now before stock runs out.`;
  const shopUrl = orderUrl?.trim() || client.return_url;

  let sent = 0;
  let failed = 0;

  for (const signup of signups) {
    if (!signup.customerInfo?.email) continue;
    try {
      await sendPreorderGoLiveEmail({
        signup,
        campaign,
        client,
        subject: subject?.trim() || `${campaign.name} — we're live! Order now`,
        message: defaultMessage,
        orderUrl: shopUrl,
      });
      signup.notes = signup.notes
        ? `${signup.notes}\nGo-live blast: ${new Date().toISOString()}`
        : `Go-live blast: ${new Date().toISOString()}`;
      await signup.save();
      sent += 1;
    } catch (err) {
      console.error('Go-live email failed:', signup.customerInfo.email, err.message);
      failed += 1;
    }
  }

  if (campaign.status !== 'ended') {
    campaign.status = 'active';
    campaign.settings = campaign.settings || {};
    campaign.settings.goLiveBlastAt = new Date();
    campaign.markModified('settings');
    await campaign.save();
  }

  res.json({
    success: true,
    message: `Go-live blast sent to ${sent} subscribers`,
    sent,
    failed,
    totalSignups: signups.length,
  });
}));

// ─── Social proof (merchant preview + public feed) ───
router.get('/social-proof', authenticateClient, wrapRoute(async (req, res) => {
  const client = await loadClient(req.clientId);
  const settings = mergeRevenueSettings(client?.revenueSettings);
  const feed = await getSocialProofFeed(req.clientId, settings);
  res.json({ success: true, settings, feed });
}));

/** Public feed for storefront widgets — no auth; clientID in path */
router.get('/public/social-proof/:clientID', wrapRoute(async (req, res) => {
  const client = await Client.findOne({ clientID: req.params.clientID }).select(
    'revenueSettings companyName'
  );
  if (!client) return res.status(404).json({ error: 'Not found' });
  const settings = mergeRevenueSettings(client.revenueSettings);
  const feed = await getSocialProofFeed(req.params.clientID, settings);
  res.json({ success: true, companyName: client.companyName, ...feed });
}));

module.exports = router;
