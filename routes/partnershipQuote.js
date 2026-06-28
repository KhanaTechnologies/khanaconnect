const express = require('express');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const PartnershipQuote = require('../models/PartnershipQuote');
const Client = require('../models/client');
const { wrapRoute } = require('../helpers/failureEmail');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { mergePartnershipPricing } = require('../helpers/partnershipPricingDefaults');
const { calculatePlanEstimate } = require('../helpers/planBuilderPricing');
const partnershipPricingRouter = require('./partnershipPricing');
const {
  QUOTE_VALIDITY_DAYS,
  computeValidUntil,
  isQuoteExpired,
  formatDisplayDate,
} = require('../helpers/planQuoteEmail');
const { sendPlanQuoteEmails, sendPlanQuoteFollowUpEmail } = require('../utils/email');
const {
  listTemplatesForQuote,
} = require('../helpers/planQuoteResponseTemplates');

const router = express.Router();

const MARKETING_SITE_URL =
  process.env.MARKETING_SITE_URL || process.env.PUBLIC_SITE_URL || 'https://khanatechnologies.co.za';

const PRICING_CACHE_MS = 2 * 60 * 1000;
let pricingCache = { at: 0, data: null };

const quoteSubmitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.params.quoteId || ''}`,
  message: {
    success: false,
    error: 'Too many submission attempts for this estimate. Please try again later.',
  },
});

const quotePatchLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.ip}:${req.params.quoteId || ''}`,
  message: {
    success: false,
    error: 'Too many updates for this estimate. Please slow down.',
  },
});

async function getPricingConfig() {
  const now = Date.now();
  if (pricingCache.data && now - pricingCache.at < PRICING_CACHE_MS) {
    return pricingCache.data;
  }
  const doc = await partnershipPricingRouter.getOrCreateConfig();
  const merged = mergePartnershipPricing(doc);
  pricingCache = { at: now, data: merged };
  return merged;
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

function serializeQuote(doc, { publicView = false } = {}) {
  const q = doc.toObject ? doc.toObject() : doc;
  const validUntil = computeValidUntil(q);
  const payload = {
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
    followUpEmails: q.followUpEmails || [],
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
  if (publicView) {
    delete payload.followUpEmails;
    if (q.status !== 'submitted') {
      payload.prospectEmail = '';
      payload.prospectPhone = '';
      payload.submittedAt = null;
    }
  }
  return payload;
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
  let doc;
  try {
    doc = await PartnershipQuote.create({
      quoteId,
      prospectName,
      businessName: String(req.body.businessName || '').trim(),
      sourceRef: String(req.body.sourceRef || 'instagram').trim(),
      createdBy: req.adminClient.clientID,
      status: 'draft',
      validUntil,
    });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(503).json({
        success: false,
        error: 'Could not generate a unique quote link. Please try again.',
      });
    }
    throw err;
  }

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

/** Admin — list follow-up email templates for a quote */
router.get('/partnership-quotes/:quoteId/response-templates', authenticateAdmin, wrapRoute(async (req, res) => {
  const quote = await PartnershipQuote.findOne({ quoteId: req.params.quoteId });
  if (!quote) {
    return res.status(404).json({ success: false, error: 'Quote not found' });
  }
  const shareUrl = buildShareUrl(quote.quoteId);
  const validUntil = computeValidUntil(quote);
  const senderName = process.env.PLAN_QUOTE_SENDER_NAME || 'The Khana team';
  const templates = listTemplatesForQuote(
    quote.toObject ? quote.toObject() : quote,
    shareUrl,
    validUntil,
    senderName
  );
  res.json({
    success: true,
    templates,
    followUpEmails: quote.followUpEmails || [],
    prospectEmail: quote.prospectEmail || '',
    canSend: !!quote.prospectEmail && quote.status === 'submitted',
  });
}));

/** Admin — send a follow-up response email to the prospect */
router.post('/partnership-quotes/:quoteId/send-response', authenticateAdmin, wrapRoute(async (req, res) => {
  const quote = await PartnershipQuote.findOne({ quoteId: req.params.quoteId });
  if (!quote) {
    return res.status(404).json({ success: false, error: 'Quote not found' });
  }
  if (!quote.prospectEmail) {
    return res.status(400).json({
      success: false,
      error: 'This prospect has not submitted an email yet.',
    });
  }

  const templateId = String(req.body?.templateId || '').trim();
  if (!templateId) {
    return res.status(400).json({ success: false, error: 'templateId is required' });
  }

  const khanaClient = await Client.findOne({ clientID: 'Khana' }).select(
    'clientID businessEmail businessEmailPassword companyName emailSignature'
  );
  if (!khanaClient?.businessEmail) {
    return res.status(503).json({
      success: false,
      error: 'Khana outbound email is not configured.',
    });
  }

  const shareUrl = buildShareUrl(quote.quoteId);
  const validUntil = computeValidUntil(quote);
  const senderName =
    String(req.body?.senderName || process.env.PLAN_QUOTE_SENDER_NAME || 'The Khana team').trim() ||
    'The Khana team';

  let rendered;
  try {
    rendered = await sendPlanQuoteFollowUpEmail({
      quote: quote.toObject ? quote.toObject() : quote,
      templateId,
      shareUrl,
      validUntil,
      khanaEmail: khanaClient.businessEmail,
      khanaPass: khanaClient.businessEmailPassword,
      companyName: khanaClient.companyName,
      emailSignature: khanaClient.emailSignature || '',
      tenantClientId: khanaClient.clientID,
      senderName,
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message || 'Failed to send email' });
  }

  quote.followUpEmails = quote.followUpEmails || [];
  quote.followUpEmails.push({
    templateId: rendered.templateId,
    templateLabel: rendered.templateLabel,
    subject: rendered.subject,
    sentAt: new Date(),
    sentBy: req.adminClient.clientID,
  });
  await quote.save();

  res.json({
    success: true,
    message: `Follow-up sent to ${quote.prospectEmail}`,
    quote: serializeQuote(quote),
    sent: {
      templateId: rendered.templateId,
      templateLabel: rendered.templateLabel,
      subject: rendered.subject,
    },
  });
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
    quote: serializeQuote(quote, { publicView: true }),
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
router.patch('/public/partnership-quote/:quoteId', quotePatchLimiter, wrapRoute(async (req, res) => {
  const quote = await PartnershipQuote.findOne({ quoteId: req.params.quoteId });
  if (!quote) {
    return res.status(404).json({ success: false, error: 'Quote not found' });
  }

  if (isQuoteExpired(quote)) {
    return res.status(410).json({
      success: false,
      error: 'This estimate has expired. Please ask your Khana contact for a new link.',
      quote: serializeQuote(quote, { publicView: true }),
    });
  }

  if (quote.status === 'submitted') {
    return res.status(409).json({
      success: false,
      error: 'This estimate was already submitted. Contact us if you need to make changes.',
      quote: serializeQuote(quote, { publicView: true }),
    });
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
    selections.wantsStandaloneApi = false;
  }
  if (selections.wantsStandaloneApi != null) {
    selections.wantsStandaloneApi = !!selections.wantsStandaloneApi;
  }

  const estimate = calculatePlanEstimate(selections, pricing);

  quote.selections = selections;
  quote.estimate = estimate;
  quote.status = 'estimated';
  quote.pricingConfigVersion = pricing.pricingConfigVersion;
  await quote.save();

  res.json({
    success: true,
    quote: serializeQuote(quote, { publicView: true }),
  });
}));

/** Public — prospect submits email; notify Khana team */
router.post('/public/partnership-quote/:quoteId/submit', quoteSubmitLimiter, wrapRoute(async (req, res) => {
  const quote = await PartnershipQuote.findOne({ quoteId: req.params.quoteId });
  if (!quote) {
    return res.status(404).json({ success: false, error: 'Quote not found' });
  }

  if (isQuoteExpired(quote)) {
    return res.status(410).json({
      success: false,
      error: 'This estimate has expired. Please ask your Khana contact for a new link.',
      quote: serializeQuote(quote, { publicView: true }),
    });
  }

  const email = String(req.body.email || '').trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ success: false, error: 'Valid email is required' });
  }

  if (quote.status === 'submitted' && quote.prospectEmail) {
    if (quote.prospectEmail === email) {
      return res.json({
        success: true,
        alreadySubmitted: true,
        emailSent: true,
        message: 'Thanks — we already have your estimate and will be in touch soon.',
        quote: serializeQuote(quote, { publicView: true }),
      });
    }
    return res.status(409).json({
      success: false,
      error: 'This estimate was already submitted with a different email. Contact us if you need help.',
      quote: serializeQuote(quote, { publicView: true }),
    });
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

  const khanaClient = await Client.findOne({ clientID: 'Khana' }).select(
    'clientID businessEmail businessEmailPassword companyName emailSignature'
  );

  let emailSent = false;
  let emailError = null;

  if (!khanaClient?.businessEmail) {
    emailError = 'Khana outbound email is not configured';
    console.error(`[planQuote] ${emailError} for ${quote.quoteId}`);
  } else {
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
      emailSent = true;
    } catch (err) {
      emailError = err.message || 'Failed to send notification emails';
      console.error('Plan quote notification email failed:', emailError);
    }
  }

  res.json({
    success: true,
    emailSent,
    emailError: emailSent ? null : emailError,
    message: emailSent
      ? 'Thanks — we have your estimate and will be in touch soon.'
      : 'Thanks — your estimate is saved. If you do not hear from us within one business day, email hello@khanatechnologies.co.za.',
    quote: serializeQuote(quote, { publicView: true }),
  });
}));

function invalidatePricingCache() {
  pricingCache = { at: 0, data: null };
}

module.exports = router;
module.exports.invalidatePricingCache = invalidatePricingCache;
