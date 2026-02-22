// routes/preorderPledges.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const PreorderPledge = require('../models/PreorderPledge');
const Campaign = require('../models/Campaign');
const { body, validationResult } = require('express-validator');
const { wrapRoute } = require('../helpers/failureEmail');

// Middleware to authenticate JWT and attach clientId
const validateClient = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });
  }

  const tokenValue = token.split(' ')[1];
  jwt.verify(tokenValue, process.env.secret, (err, user) => {
    if (err || !user.clientID) {
      return res.status(403).json({ error: 'Forbidden - Invalid token' });
    }
    req.clientId = user.clientID;
    req.user = {
      id: user.clientID,
      role: user.role || 'user'
    };
    next();
  });
};

// Admin check middleware
const requireAdmin = (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ 
      success: false,
      error: 'Admin access required' 
    });
  }
  next();
};

// Validation for interest campaign signup (SIMPLE FORM)
const interestSignupValidation = [
  body('campaignId').isMongoId().withMessage('Valid campaign ID is required'),
  body('customerInfo.name').notEmpty().withMessage('Your name is required'),
  body('customerInfo.email').isEmail().withMessage('Valid email is required'),
  body('interestLevel').optional().isIn(['low', 'medium', 'high']).withMessage('Invalid interest level'),
  body('expectedQuantity').optional().isInt({ min: 1 }).withMessage('Expected quantity must be at least 1'),
  body('source').optional().isString()
];

// Validation for funding campaign interest (no pledge yet)
const fundingInterestValidation = [
  body('campaignId').isMongoId().withMessage('Valid campaign ID is required'),
  body('customerInfo.name').notEmpty().withMessage('Your name is required'),
  body('customerInfo.email').isEmail().withMessage('Valid email is required'),
  body('pledgeTier').optional().isString(),
  body('source').optional().isString()
];

// Validation for funding campaign pledge (commitment)
const fundingPledgeValidation = [
  body('campaignId').isMongoId().withMessage('Valid campaign ID is required'),
  body('pledgeAmount').isNumeric().withMessage('Valid pledge amount is required'),
  body('customerInfo.name').notEmpty().withMessage('Your name is required'),
  body('customerInfo.email').isEmail().withMessage('Valid email is required'),
  body('paymentMethod').isIn(['bank_transfer', 'eft', 'cash', 'credit_card', 'paypal', 'crypto']).withMessage('Valid payment method required'),
  body('isObligated').equals('true').withMessage('Must be true for pledge')
];

// Simple signup for interest campaign (no money, just interest)
router.post('/interest-campaign-signup', validateClient, interestSignupValidation, wrapRoute(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  // Check if campaign exists and is an interest campaign
  const campaign = await Campaign.findOne({
    _id: req.body.campaignId,
    clientId: req.clientId,
    campaignType: 'interest',
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      error: 'Interest campaign not found'
    });
  }

  // Check if campaign is active
  if (!campaign.isActive()) {
    return res.status(400).json({
      success: false,
      error: 'Campaign is not active'
    });
  }

  // Check if email already signed up (if not allowing multiple)
  if (!campaign.settings.allowMultipleSignups) {
    const existing = await PreorderPledge.findOne({
      campaignId: campaign._id,
      'customerInfo.email': req.body.customerInfo.email,
      isDeleted: false
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'This email has already signed up for this campaign',
        data: {
          existingSignupId: existing.preorderId,
          signupDate: existing.signupDate
        }
      });
    }
  }

  // Create the signup
  const signupData = {
    ...req.body,
    productId: campaign.products[0]?.productId || null,
    productName: campaign.products[0]?.productName || campaign.name,
    campaignType: 'interest',
    isObligated: false,
    pledgeAmount: 0,
    paymentStatus: 'not_applicable',
    paymentMethod: 'not_applicable',
    status: 'interested',
    clientId: req.clientId,
    campaignEndDate: campaign.endDate
  };

  const signup = new PreorderPledge(signupData);
  await signup.save();

  res.status(201).json({
    success: true,
    data: {
      preorderId: signup.preorderId,
      name: signup.customerInfo.name,
      email: signup.customerInfo.email,
      signupDate: signup.signupDate,
      campaignName: campaign.name
    },
    message: 'Thanks for your interest! We\'ll keep you updated.'
  });
}));

// Simple signup for funding campaign (just interest, no pledge)
router.post('/funding-campaign-interest', validateClient, fundingInterestValidation, wrapRoute(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  // Check if campaign exists and is a funding campaign
  const campaign = await Campaign.findOne({
    _id: req.body.campaignId,
    clientId: req.clientId,
    campaignType: 'funding',
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      error: 'Funding campaign not found'
    });
  }

  // Check if campaign is active
  if (!campaign.isActive()) {
    return res.status(400).json({
      success: false,
      error: 'Campaign is not active'
    });
  }

  // Check for existing signup
  const existing = await PreorderPledge.findOne({
    campaignId: campaign._id,
    'customerInfo.email': req.body.customerInfo.email,
    isDeleted: false
  });

  if (existing) {
    return res.status(400).json({
      success: false,
      error: 'This email has already registered interest for this campaign',
      data: {
        existingId: existing.preorderId,
        type: existing.isObligated ? 'Already pledged' : 'Already interested',
        signupDate: existing.signupDate
      }
    });
  }

  // Create interest record
  const interestData = {
    ...req.body,
    productId: campaign.products[0]?.productId || null,
    productName: campaign.products[0]?.productName || campaign.name,
    campaignType: 'funding',
    isObligated: false,
    pledgeAmount: 0,
    paymentStatus: 'not_applicable',
    paymentMethod: 'not_applicable',
    status: 'interested',
    clientId: req.clientId,
    campaignEndDate: campaign.endDate
  };

  const interest = new PreorderPledge(interestData);
  await interest.save();

  res.status(201).json({
    success: true,
    data: {
      preorderId: interest.preorderId,
      name: interest.customerInfo.name,
      email: interest.customerInfo.email,
      signupDate: interest.signupDate,
      campaignName: campaign.name
    },
    message: 'Interest registered! We\'ll notify you when the campaign is ready for pledges.'
  });
}));

// Make a pledge (commitment) for funding campaign
router.post('/funding-campaign-pledge', validateClient, fundingPledgeValidation, wrapRoute(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  // Check if campaign exists and is a funding campaign
  const campaign = await Campaign.findOne({
    _id: req.body.campaignId,
    clientId: req.clientId,
    campaignType: 'funding',
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      error: 'Funding campaign not found'
    });
  }

  // Check if campaign is active
  if (!campaign.isActive()) {
    return res.status(400).json({
      success: false,
      error: 'Campaign is not active'
    });
  }

  // Check for existing pledge with same email
  const existing = await PreorderPledge.findOne({
    campaignId: campaign._id,
    'customerInfo.email': req.body.customerInfo.email,
    isObligated: true,
    isDeleted: false
  });

  if (existing) {
    return res.status(400).json({
      success: false,
      error: 'This email has already made a pledge for this campaign',
      data: {
        existingPledgeId: existing.preorderId,
        pledgeAmount: existing.pledgeAmount,
        pledgeDate: existing.commitmentDate
      }
    });
  }

  // Check if there was an interest record to link
  const existingInterest = await PreorderPledge.findOne({
    campaignId: campaign._id,
    'customerInfo.email': req.body.customerInfo.email,
    isObligated: false,
    isDeleted: false
  });

  // Create pledge
  const pledgeData = {
    ...req.body,
    productId: campaign.products[0]?.productId || null,
    productName: campaign.products[0]?.productName || campaign.name,
    campaignType: 'funding',
    isObligated: true,
    paymentStatus: 'pending',
    status: 'committed',
    commitmentDate: new Date(),
    clientId: req.clientId,
    campaignEndDate: campaign.endDate,
    convertedFrom: existingInterest?._id,
    convertedAt: existingInterest ? new Date() : null
  };

  const pledge = new PreorderPledge(pledgeData);
  await pledge.save();

  // Update the interest record if it exists
  if (existingInterest) {
    existingInterest.status = 'converted';
    await existingInterest.save();
  }

  res.status(201).json({
    success: true,
    data: {
      preorderId: pledge.preorderId,
      name: pledge.customerInfo.name,
      email: pledge.customerInfo.email,
      pledgeAmount: pledge.pledgeAmount,
      commitmentDate: pledge.commitmentDate,
      campaignName: campaign.name
    },
    message: 'Thank you for your pledge! Please complete payment to confirm.'
  });
}));

// Get all signups/pledges (with filters)
router.get('/', validateClient, wrapRoute(async (req, res) => {
  const {
    status,
    campaignType,
    campaignId,
    isObligated,
    startDate,
    endDate,
    limit = 50,
    page = 1,
    sortBy = 'createdAt',
    sortOrder = 'desc'
  } = req.query;

  const filter = { 
    clientId: req.clientId,
    isDeleted: false 
  };
  
  if (status) filter.status = status;
  if (campaignType) filter.campaignType = campaignType;
  if (isObligated !== undefined) filter.isObligated = isObligated === 'true';
  if (campaignId) filter.campaignId = campaignId;
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);
  }

  const sort = {};
  sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

  const skip = (page - 1) * limit;

  const preorders = await PreorderPledge.find(filter)
    .populate('productId', 'name price')
    .populate('campaignId', 'name campaignType endDate')
    .populate('convertedFrom', 'preorderId signupDate')
    .sort(sort)
    .limit(parseInt(limit))
    .skip(skip);

  const total = await PreorderPledge.countDocuments(filter);

  // Group by type for response
  const grouped = {
    interestCampaignSignups: preorders.filter(p => p.campaignType === 'interest'),
    fundingCampaignInterests: preorders.filter(p => p.campaignType === 'funding' && !p.isObligated),
    fundingCampaignPledges: preorders.filter(p => p.campaignType === 'funding' && p.isObligated)
  };

  res.json({
    success: true,
    data: grouped,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
}));

// Get single record by ID
router.get('/:id', validateClient, wrapRoute(async (req, res) => {
  const preorder = await PreorderPledge.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  })
    .populate('productId')
    .populate('campaignId')
    .populate('convertedFrom');

  if (!preorder) {
    return res.status(404).json({
      success: false,
      message: 'Record not found'
    });
  }

  const preorderObject = preorder.toObject();
  preorderObject.daysUntilDelivery = preorder.getDaysUntilDelivery();
  preorderObject.isOverdue = preorder.isOverdue();
  preorderObject.responseType = preorder.responseType;

  res.json({
    success: true,
    data: preorderObject
  });
}));

// Get all signups for an interest campaign (for marketing)
router.get('/campaign/:campaignId/signups', validateClient, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.campaignId,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  const signups = await PreorderPledge.find({
    campaignId: campaign._id,
    isDeleted: false
  }).sort({ signupDate: -1 });

  // Return appropriate fields based on campaign type
  let sanitized;
  if (campaign.campaignType === 'interest') {
    sanitized = signups.map(s => ({
      preorderId: s.preorderId,
      name: s.customerInfo.name,
      email: s.customerInfo.email,
      phone: s.customerInfo.phone,
      interestLevel: s.interestLevel,
      expectedQuantity: s.expectedQuantity,
      signupDate: s.signupDate,
      source: s.source,
      communicationPreferences: s.communicationPreferences
    }));
  } else {
    sanitized = signups.map(s => ({
      preorderId: s.preorderId,
      name: s.customerInfo.name,
      email: s.customerInfo.email,
      type: s.isObligated ? 'Pledge' : 'Interest',
      pledgeAmount: s.pledgeAmount,
      pledgeTier: s.pledgeTier,
      paymentStatus: s.paymentStatus,
      signupDate: s.signupDate,
      commitmentDate: s.commitmentDate
    }));
  }

  res.json({
    success: true,
    data: sanitized,
    count: sanitized.length,
    campaignType: campaign.campaignType
  });
}));

// Export signups for a campaign (CSV)
router.get('/campaign/:campaignId/export', validateClient, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.campaignId,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  const signups = await PreorderPledge.find({
    campaignId: campaign._id,
    isDeleted: false
  }).sort({ signupDate: -1 });

  // Create CSV based on campaign type
  let csvHeader, csvRows;
  
  if (campaign.campaignType === 'interest') {
    csvHeader = 'Name,Email,Phone,Interest Level,Expected Quantity,Signup Date,Source,Email Updates,SMS Updates,Marketing Consent\n';
    csvRows = signups.map(s => 
      `${s.customerInfo.name},${s.customerInfo.email},${s.customerInfo.phone || ''},${s.interestLevel || ''},${s.expectedQuantity || 1},${s.signupDate},${s.source || ''},${s.communicationPreferences.emailUpdates},${s.communicationPreferences.smsUpdates},${s.communicationPreferences.marketingConsent}`
    ).join('\n');
  } else {
    csvHeader = 'Name,Email,Type,Amount,Tier,Payment Status,Signup Date,Commitment Date\n';
    csvRows = signups.map(s => 
      `${s.customerInfo.name},${s.customerInfo.email},${s.isObligated ? 'Pledge' : 'Interest'},${s.pledgeAmount || 0},${s.pledgeTier || ''},${s.paymentStatus},${s.signupDate},${s.commitmentDate || ''}`
    ).join('\n');
  }
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=${campaign.name.replace(/\s+/g, '-').toLowerCase()}-signups.csv`);
  res.send(csvHeader + csvRows);
}));

// Update payment status (for pledges only)
router.patch('/:id/payment', validateClient, wrapRoute(async (req, res) => {
  const { paymentStatus, transactionId } = req.body;
  
  const preorder = await PreorderPledge.findOne({ 
    _id: req.params.id, 
    clientId: req.clientId 
  });

  if (!preorder) {
    return res.status(404).json({
      success: false,
      message: 'Record not found'
    });
  }

  if (!preorder.isObligated || preorder.campaignType !== 'funding') {
    return res.status(400).json({
      success: false,
      error: 'Can only update payment for obligated funding pledges'
    });
  }

  const updateData = {
    paymentStatus,
    lastUpdatedBy: req.clientId
  };

  if (paymentStatus === 'paid') {
    updateData['paymentDetails.transactionId'] = transactionId;
    updateData['paymentDetails.paidAt'] = new Date();
  }

  const updated = await PreorderPledge.findOneAndUpdate(
    { _id: req.params.id },
    updateData,
    { new: true }
  );

  // Send email notification
  if (paymentStatus === 'paid') {
    setImmediate(async () => {
      try {
        console.log(`📧 Payment confirmation for pledge ${preorder.preorderId} would be sent to ${preorder.customerInfo.email}`);
      } catch (emailError) {
        console.error('⚠️ Background payment email failed:', emailError.message);
      }
    });
  }

  res.json({
    success: true,
    data: updated,
    message: `Payment status updated to ${paymentStatus}`
  });
}));

// Cancel/remove signup
router.patch('/:id/cancel', validateClient, wrapRoute(async (req, res) => {
  const { reason } = req.body;
  
  const preorder = await PreorderPledge.findOne({ 
    _id: req.params.id, 
    clientId: req.clientId 
  });
  
  if (!preorder) {
    return res.status(404).json({
      success: false,
      message: 'Record not found'
    });
  }

  preorder.status = 'cancelled';
  preorder.notes = preorder.notes 
    ? `${preorder.notes}\nCancelled: ${reason || 'No reason provided'} (${new Date().toISOString()})`
    : `Cancelled: ${reason || 'No reason provided'} (${new Date().toISOString()})`;
  preorder.lastUpdatedBy = req.clientId;
  
  await preorder.save();

  // If it was a paid pledge, trigger refund
  if (preorder.isObligated && preorder.paymentStatus === 'paid') {
    setImmediate(async () => {
      try {
        console.log(`🔄 Auto-refund initiated for cancelled pledge ${preorder.preorderId}`);
      } catch (error) {
        console.error('Failed to initiate refund:', error);
      }
    });
  }

  // Send cancellation email
  setImmediate(async () => {
    try {
      console.log(`📧 Cancellation email for ${preorder.preorderId} would be sent to ${preorder.customerInfo.email}`);
    } catch (emailError) {
      console.error('⚠️ Background cancellation email failed:', emailError.message);
    }
  });

  const message = preorder.campaignType === 'interest' 
    ? 'Interest signup cancelled successfully' 
    : 'Pledge cancelled successfully';

  res.json({
    success: true,
    data: preorder,
    message
  });
}));

// Get campaign statistics
router.get('/campaign/:campaignId/stats', validateClient, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.campaignId,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  const stats = await PreorderPledge.getCampaignStats(req.params.campaignId);
  
  res.json({
    success: true,
    data: stats,
    campaignType: campaign.campaignType
  });
}));

// Send email to all signups (admin only)
router.post('/campaign/:campaignId/notify', validateClient, requireAdmin, wrapRoute(async (req, res) => {
  const { subject, message } = req.body;
  
  const campaign = await Campaign.findOne({
    _id: req.params.campaignId,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  const signups = await PreorderPledge.find({
    campaignId: campaign._id,
    isDeleted: false,
    'communicationPreferences.emailUpdates': true
  });

  setImmediate(async () => {
    for (const signup of signups) {
      try {
        console.log(`📧 Email would be sent to ${signup.customerInfo.email}: ${subject}`);
        
        signup.notes = signup.notes 
          ? `${signup.notes}\nNotification sent: ${subject} (${new Date().toISOString()})`
          : `Notification sent: ${subject} (${new Date().toISOString()})`;
        await signup.save();
      } catch (error) {
        console.error(`Failed to notify ${signup.customerInfo.email}:`, error);
      }
    }
  });

  res.json({
    success: true,
    message: `Started notifying ${signups.length} signups`,
    count: signups.length
  });
}));

module.exports = router;