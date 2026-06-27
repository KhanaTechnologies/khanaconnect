const express = require('express');
const jwt = require('jsonwebtoken');
const PartnershipPricingConfig = require('../models/PartnershipPricingConfig');
const Client = require('../models/client');
const { wrapRoute } = require('../helpers/failureEmail');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const {
  PRICING_CONFIG_VERSION,
  DEFAULT_PARTNERSHIP_PRICING,
  mergePartnershipPricing,
} = require('../helpers/partnershipPricingDefaults');

const router = express.Router();

function needsPricingMigration(doc) {
  if (!doc) return true;
  if ((doc.pricingConfigVersion || 0) < PRICING_CONFIG_VERSION) return true;
  const tierIds = new Set((doc.tiers || []).map((t) => t.id));
  const required = ['starter', 'launch', 'growth', 'scale', 'enterprise'];
  return required.some((id) => !tierIds.has(id));
}

async function getOrCreateConfig() {
  let doc = await PartnershipPricingConfig.findOne({ configKey: 'default' });
  if (!doc) {
    doc = await PartnershipPricingConfig.create({
      configKey: 'default',
      ...DEFAULT_PARTNERSHIP_PRICING,
    });
    return doc;
  }

  if (needsPricingMigration(doc)) {
    Object.assign(doc, DEFAULT_PARTNERSHIP_PRICING);
    doc.pricingConfigVersion = PRICING_CONFIG_VERSION;
    doc.markModified('tiers');
    doc.markModified('addOns');
    doc.markModified('faqs');
    doc.markModified('comparisonFeatures');
    await doc.save();
  }

  return doc;
}

async function authenticateAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  try {
    const { decoded } = verifyJwtWithAnySecret(jwt, auth.split(' ')[1]);
    if (!decoded?.clientID) {
      return res.status(403).json({ success: false, error: 'Client token required' });
    }
    const client = await Client.findOne({ clientID: decoded.clientID }).select('clientID role Client');
    if (!client || client.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    req.adminClient = client;
    next();
  } catch (_e) {
    return res.status(403).json({ success: false, error: 'Invalid token' });
  }
}

function sortConfig(config) {
  const sorted = { ...config };
  sorted.tiers = [...(sorted.tiers || [])]
    .filter((t) => t.active !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  sorted.addOns = [...(sorted.addOns || [])]
    .filter((a) => a.active !== false)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  sorted.faqs = [...(sorted.faqs || [])].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  return sorted;
}

/** Public — marketing website */
router.get('/public/partnership-pricing', wrapRoute(async (_req, res) => {
  const doc = await getOrCreateConfig();
  const config = sortConfig(mergePartnershipPricing(doc));
  res.json({ success: true, config });
}));

/** Admin — full config including inactive items */
router.get('/partnership-pricing', authenticateAdmin, wrapRoute(async (_req, res) => {
  const doc = await getOrCreateConfig();
  res.json({ success: true, config: mergePartnershipPricing(doc) });
}));

router.put('/partnership-pricing', authenticateAdmin, wrapRoute(async (req, res) => {
  const body = req.body?.config || req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ success: false, error: 'config object required' });
  }

  const doc = await getOrCreateConfig();
  const allowed = [
    'showPublishedPrices',
    'currency',
    'currencySymbol',
    'billingNote',
    'vatNote',
    'tiers',
    'addOns',
    'faqs',
    'comparisonFeatures',
    'pricingConfigVersion',
  ];

  allowed.forEach((key) => {
    if (body[key] !== undefined) doc[key] = body[key];
  });
  doc.updatedBy = req.adminClient.clientID;
  doc.markModified('tiers');
  doc.markModified('addOns');
  doc.markModified('faqs');
  doc.markModified('comparisonFeatures');
  await doc.save();

  res.json({ success: true, config: mergePartnershipPricing(doc) });
}));

router.post('/partnership-pricing/reset', authenticateAdmin, wrapRoute(async (req, res) => {
  const doc = await getOrCreateConfig();
  Object.assign(doc, DEFAULT_PARTNERSHIP_PRICING);
  doc.updatedBy = req.adminClient.clientID;
  doc.markModified('tiers');
  doc.markModified('addOns');
  doc.markModified('faqs');
  doc.markModified('comparisonFeatures');
  await doc.save();
  res.json({ success: true, config: mergePartnershipPricing(doc) });
}));

router.getOrCreateConfig = getOrCreateConfig;

module.exports = router;
