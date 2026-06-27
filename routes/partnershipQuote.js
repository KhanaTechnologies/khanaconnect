const express = require('express');
const jwt = require('jsonwebtoken');
const PartnershipQuote = require('../models/PartnershipQuote');
const Client = require('../models/client');
const { wrapRoute } = require('../helpers/failureEmail');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { mergePartnershipPricing } = require('../helpers/partnershipPricingDefaults');
const { calculatePlanEstimate } = require('../helpers/planBuilderPricing');
const {
  QUOTE_VALIDITY_DAYS,
  computeValidUntil,
  isQuoteExpired,
  formatDisplayDate,
} = require('../helpers/planQuoteEmail');
const { sendPlanQuoteEmails } = require('../utils/email');

const router = express.Router();

const MARKETING_SITE_URL =
  process.env.MARKETING_SITE_URL || process.env.PUBLIC_SITE_URL || 'https://khanatechnologies.co.za';

async function getPricingConfig() {
  const PartnershipPricingConfig = require('../models/PartnershipPricingConfig');
  const { DEFAULT_PARTNERSHIP_PRICING } = require('../helpers/partnershipPricingDefaults');
  let doc = await PartnershipPricingConfig.findOne({ configKey: 'default' });
  if (!doc) {
    doc = await PartnershipPricingConfig.create({
      configKey: 'default',
      ...DEFAULT_PARTNERSHIP_PRICING,
    });
  }
  return mergePartnershipPricing(doc);
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

function buildSharePath(quoteId) {
  return `/get-started/q/${quoteId}`;
}

function buildShareUrl(quoteId) {
  return `${MARKETING_SITE_URL.replace(/\/$/, '')}${buildSharePath(quoteId)}`;
}

function serializeQuote(doc) {
  const q = doc.toObject ? doc.toObject() : doc;
  const validUntil = computeValidUntil(q);
  return {
    quoteId: q.quoteId,
    prospectName: q.prospectName,
    businessName: q.businessName,
    sourceRef: q.sourceRef,
    status: q.status,
    selections: q.selections,
    estimate: q.estimate,
    prospectEmail: q.prospectEmail,
    prospectPhone: q.prospectPhone,
    submittedAt: q.submittedAt,
    validUntil: validUntil.toISOString(),
    validUntilLabel: formatDisplayDate(validUntil),
    isExpired: isQuoteExpired(q),
    shareUrl: buildShareUrl(q.quoteId),
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

function defaultValidUntil() {
  const until = new Date();
  until.setDate(until.getDate() + QUOTE_VALIDITY_DAYS);
  return until;
}

/** Admin — create personalized link for a prospect */
router.post('/partnership-quotes', authenticateAdmin, wrapRoute(async (req, res) => {
  const prospectName = String(req.body.prospectName || '').trim();
  if (!prospectName) {
    return res.status(400).json({ success: false, error: 'prospectName is required' });
  }

  const quoteId = PartnershipQuote.generateQuoteId();
  const validUntil = defaultValidUntil();
  const doc = await PartnershipQuote.create({
    quoteId,
    prospectName,
    businessName: String(req.body.businessName || '').trim(),
    sourceRef: String(req.body.sourceRef || 'instagram').trim(),
    createdBy: req.adminClient.clientID,
    status: 'draft',
    validUntil,
  });

  res.status(201).json({
    success: true,
    quote: serializeQuote(doc),
    shareUrl: buildShareUrl(quoteId),
    sharePath: buildSharePath(quoteId),
  });
}));

/** Admin — list recent quotes */
router.get('/partnership-quotes', authenticateAdmin, wrapRoute(async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || '30'), 10) || 30));
  const quotes = await PartnershipQuote.find()
    .sort({ createdAt: -1 })
    .limit(limit);
  res.json({
    success: true,
    quotes: quotes.map(serializeQuote),
  });
}));

/** Admin — delete a plan builder link */
router.delete('/partnership-quotes/:quoteId', authenticateAdmin, wrapRoute(async (req, res) => {
  const quote = await PartnershipQuote.findOneAndDelete({ quoteId: req.params.quoteId });
  if (!quote) {
    return res.status(404).json({ success: false, error: 'Quote not found' });
  }
  res.json({ success: true, message: 'Plan builder link deleted' });
}));

/** Public — load personalized quote session */
router.get('/public/partnership-quote/:quoteId', wrapRoute(async (req, res) => {
  const quote = await PartnershipQuote.findOne({ quoteId: req.params.quoteId });
  if (!quote) {
    return res.status(404).json({ success: false, error: 'Quote not found' });
  }
  const pricing = await getPricingConfig();
  res.json({
    success: true,
    quote: serializeQuote(quote),
    pricing: {
      currency: pricing.currency,
      currencySymbol: pricing.currencySymbol,
      billingNote: pricing.billingNote,
      vatNote: pricing.vatNote,
      planBuilder: pricing.planBuilder,
    },
  });
}));

/** Public — save selections and return estimate */
router.patch('/public/partnership-quote/:quoteId', wrapRoute(async (req, res) => {
  const quote = await PartnershipQuote.findOne({ quoteId: req.params.quoteId });
  if (!quote) {
    return res.status(404).json({ success: false, error: 'Quote not found' });
  }

  const pricing = await getPricingConfig();
  const selections = {
    ...quote.selections?.toObject?.() || quote.selections || {},
    ...req.body.selections,
  };

  if (req.body.sourceRef != null) {
    quote.sourceRef = String(req.body.sourceRef).trim().slice(0, 80);
  }

  if (selections.teamMembers != null) {
    selections.teamMembers = Math.min(50, Math.max(1, parseInt(selections.teamMembers, 10) || 1));
  }

  if (selections.customBrief != null) {
    selections.customBrief = String(selections.customBrief).trim().slice(0, 2000);
  }
  if (selections.customScope != null) {
    const scope = String(selections.customScope).trim();
    selections.customScope = scope === 'addon' ? 'addon' : 'standalone';
  }
  if (selections.needsCustom === false) {
    selections.customBrief = '';
  }

  const estimate = calculatePlanEstimate(selections, pricing);

  quote.selections = selections;
  quote.estimate = estimate;
  quote.status = 'estimated';
  quote.pricingConfigVersion = pricing.pricingConfigVersion;
  await quote.save();

  res.json({
    success: true,
    quote: serializeQuote(quote),
  });
}));

/** Public — prospect submits email; notify Khana team */
router.post('/public/partnership-quote/:quoteId/submit', wrapRoute(async (req, res) => {
  const quote = await PartnershipQuote.findOne({ quoteId: req.params.quoteId });
  if (!quote) {
    return res.status(404).json({ success: false, error: 'Quote not found' });
  }

  if (isQuoteExpired(quote)) {
    return res.status(410).json({
      success: false,
      error: 'This estimate has expired. Please ask your Khana contact for a new link.',
      quote: serializeQuote(quote),
    });
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ success: false, error: 'Valid email is required' });
  }

  if (req.body.selections) {
    const pricing = await getPricingConfig();
    quote.selections = { ...quote.selections?.toObject?.() || quote.selections, ...req.body.selections };
    quote.estimate = calculatePlanEstimate(quote.selections, pricing);
  }

  quote.prospectEmail = email;
  quote.prospectPhone = String(req.body.phone || '').trim();
  quote.status = 'submitted';
  quote.submittedAt = new Date();
  await quote.save();

  const pricing = await getPricingConfig();
  const khanaClient = await Client.findOne({ clientID: 'Khana' }).select(
    'clientID businessEmail businessEmailPassword companyName emailSignature'
  );

  if (khanaClient?.businessEmail) {
    try {
      const shareUrl = buildShareUrl(quote.quoteId);
      const validUntil = computeValidUntil(quote);
      await sendPlanQuoteEmails({
        quote: quote.toObject ? quote.toObject() : quote,
        shareUrl,
        validUntil,
        prospectEmail: email,
        khanaEmail: khanaClient.businessEmail,
        khanaPass: khanaClient.businessEmailPassword,
        companyName: khanaClient.companyName,
        emailSignature: khanaClient.emailSignature || '',
        tenantClientId: khanaClient.clientID,
      });
    } catch (err) {
      console.error('Plan quote notification email failed:', err.message);
    }
  }

  res.json({
    success: true,
    message: 'Thanks — we have your estimate and will be in touch soon.',
    quote: serializeQuote(quote),
  });
}));

module.exports = router;
