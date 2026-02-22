// routes/campaigns.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Campaign = require('../models/Campaign');
const PreorderPledge = require('../models/PreorderPledge');
const { body, validationResult } = require('express-validator');
const { wrapRoute } = require('../helpers/failureEmail');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/campaigns';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'campaign-' + uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  if (!file.originalname.match(/\.(jpg|JPG|jpeg|JPEG|png|PNG|gif|GIF|webp|WEBP)$/)) {
    req.fileValidationError = 'Only image files are allowed';
    return cb(new Error('Only image files are allowed'), false);
  }
  cb(null, true);
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: fileFilter
});

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

// FIXED: Validation rules based on campaign type - now returns a middleware function
const campaignValidation = (req, res, next) => {
  // First, check if body exists
  if (!req.body) {
    return res.status(400).json({ 
      success: false, 
      error: 'Request body is missing' 
    });
  }

  const { campaignType } = req.body;
  
  // Base validations that apply to all campaigns
  const validations = [
    body('name').notEmpty().withMessage('Campaign name is required'),
    body('description').notEmpty().withMessage('Description is required'),
    body('campaignType').isIn(['funding', 'interest']).withMessage('Valid campaign type required'),
    body('startDate').isISO8601().withMessage('Valid start date is required'),
    body('endDate').isISO8601().withMessage('Valid end date is required')
  ];

  // Add type-specific validations
  if (campaignType === 'funding') {
    validations.push(
      body('fundingGoal').isNumeric().withMessage('Valid funding goal is required for funding campaigns'),
      body('minimumPledge').optional().isNumeric().withMessage('Minimum pledge must be a number')
    );
  } else if (campaignType === 'interest') {
    validations.push(
      body('fundingGoal').optional().isEmpty().withMessage('Funding goal not needed for interest campaigns'),
      body('rewardTiers').optional().isEmpty().withMessage('Reward tiers not needed for interest campaigns')
    );
  }

  // Run all validations
  return Promise.all(validations.map(validation => validation.run(req)))
    .then(() => {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }
      next();
    })
    .catch(err => {
      return res.status(500).json({ 
        success: false, 
        error: 'Validation error: ' + err.message 
      });
    });
};

// Create a new campaign
router.post('/', validateClient, campaignValidation, wrapRoute(async (req, res) => {
  // Add client info from token
  req.body.clientId = req.clientId;
  req.body.createdBy = req.clientId;

  // Validate dates
  const startDate = new Date(req.body.startDate);
  const endDate = new Date(req.body.endDate);
  
  if (startDate >= endDate) {
    return res.status(400).json({
      success: false,
      error: 'End date must be after start date'
    });
  }

  // Set status based on dates
  const now = new Date();
  if (startDate <= now && endDate >= now) {
    req.body.status = 'active';
  } else if (startDate > now) {
    req.body.status = 'draft';
  }

  // Initialize media object if not provided
  if (!req.body.media) {
    req.body.media = {};
  }

  // Set default values based on campaign type
  if (req.body.campaignType === 'interest') {
    req.body.fundingGoal = undefined;
    req.body.rewardTiers = [];
    req.body.amountRaised = 0;
    req.body.backersCount = 0;
  }

  const campaign = new Campaign(req.body);
  await campaign.save();

  const message = req.body.campaignType === 'funding' 
    ? 'Funding campaign created successfully' 
    : 'Interest campaign created successfully';

  res.status(201).json({
    success: true,
    data: campaign,
    message
  });
}));

// Get campaigns by type
router.get('/type/:type', validateClient, wrapRoute(async (req, res) => {
  const { type } = req.params;
  
  if (!['funding', 'interest'].includes(type)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid campaign type'
    });
  }

  const campaigns = await Campaign.find({
    clientId: req.clientId,
    campaignType: type,
    isDeleted: false
  }).sort({ createdAt: -1 });

  res.json({
    success: true,
    data: campaigns,
    count: campaigns.length,
    type
  });
}));

// Get campaign statistics by type
router.get('/stats/by-type', validateClient, wrapRoute(async (req, res) => {
  const fundingStats = await Campaign.aggregate([
    { $match: { clientId: req.clientId, campaignType: 'funding', isDeleted: false } },
    { $group: {
      _id: null,
      total: { $sum: 1 },
      active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
      totalRaised: { $sum: '$amountRaised' },
      totalBackers: { $sum: '$backersCount' },
      totalGoal: { $sum: '$fundingGoal' }
    }}
  ]);

  const interestStats = await Campaign.aggregate([
    { $match: { clientId: req.clientId, campaignType: 'interest', isDeleted: false } },
    { $group: {
      _id: null,
      total: { $sum: 1 },
      active: { $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] } },
      totalInterested: { $sum: '$interestedCount' },
      totalUnique: { $sum: '$uniqueSignupsCount' }
    }}
  ]);

  res.json({
    success: true,
    data: {
      funding: fundingStats[0] || { total: 0, active: 0, totalRaised: 0, totalBackers: 0, totalGoal: 0 },
      interest: interestStats[0] || { total: 0, active: 0, totalInterested: 0, totalUnique: 0 }
    }
  });
}));

// Upload cover image for campaign
router.post('/:id/upload-cover', validateClient, upload.single('coverImage'), wrapRoute(async (req, res) => {
  if (req.fileValidationError) {
    return res.status(400).json({
      success: false,
      error: req.fileValidationError
    });
  }

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: 'No image file provided'
    });
  }

  const campaign = await Campaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    fs.unlinkSync(req.file.path);
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  // Delete old cover image if exists
  if (campaign.media && campaign.media.coverImage) {
    const oldImagePath = campaign.media.coverImage.replace(/^.*[\\\/]uploads[\\\/]/, 'uploads/');
    if (fs.existsSync(oldImagePath)) {
      fs.unlinkSync(oldImagePath);
    }
  }

  const imageUrl = `/uploads/campaigns/${req.file.filename}`;
  campaign.media.coverImage = imageUrl;
  await campaign.save();

  res.json({
    success: true,
    data: {
      coverImage: imageUrl,
      filename: req.file.filename
    },
    message: 'Cover image uploaded successfully'
  });
}));

// Upload multiple gallery images
router.post('/:id/upload-gallery', validateClient, upload.array('gallery', 10), wrapRoute(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No gallery images provided'
    });
  }

  const campaign = await Campaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    req.files.forEach(file => fs.unlinkSync(file.path));
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  if (!campaign.media) campaign.media = {};
  if (!campaign.media.gallery) campaign.media.gallery = [];

  const uploadedImages = req.files.map(file => ({
    url: `/uploads/campaigns/${file.filename}`,
    caption: req.body.captions ? req.body.captions[file.fieldname] : ''
  }));

  campaign.media.gallery.push(...uploadedImages);
  await campaign.save();

  res.json({
    success: true,
    data: {
      gallery: campaign.media.gallery,
      uploaded: uploadedImages
    },
    message: `${req.files.length} gallery images uploaded successfully`
  });
}));

// Get all campaigns for client
router.get('/', validateClient, wrapRoute(async (req, res) => {
  const {
    status,
    campaignType,
    category,
    search,
    startDate,
    endDate,
    limit = 20,
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
  if (category) filter.categories = { $in: [category] };
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { description: { $regex: search, $options: 'i' } }
    ];
  }
  if (startDate || endDate) {
    filter.createdAt = {};
    if (startDate) filter.createdAt.$gte = new Date(startDate);
    if (endDate) filter.createdAt.$lte = new Date(endDate);
  }

  const sort = {};
  sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

  const skip = (page - 1) * limit;

  const campaigns = await Campaign.find(filter)
    .sort(sort)
    .limit(parseInt(limit))
    .skip(skip);

  const total = await Campaign.countDocuments(filter);

  // Add virtuals
  const campaignsWithVirtuals = campaigns.map(c => {
    const obj = c.toObject();
    obj.daysRemaining = c.daysRemaining;
    obj.progressPercentage = c.progressPercentage;
    obj.isExpired = c.isExpired;
    obj.totalResponses = c.totalResponses;
    obj.typeDisplay = c.typeDisplay;
    return obj;
  });

  res.json({
    success: true,
    data: campaignsWithVirtuals,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / limit)
    }
  });
}));

// Get active campaigns only
router.get('/active', validateClient, wrapRoute(async (req, res) => {
  const { type } = req.query;
  
  const campaigns = await Campaign.findActiveByClient(req.clientId, type);
  
  const campaignsWithVirtuals = campaigns.map(c => {
    const obj = c.toObject();
    obj.daysRemaining = c.daysRemaining;
    obj.progressPercentage = c.progressPercentage;
    obj.totalResponses = c.totalResponses;
    obj.typeDisplay = c.typeDisplay;
    return obj;
  });

  res.json({
    success: true,
    data: campaignsWithVirtuals,
    count: campaigns.length
  });
}));

// Get single campaign by ID
router.get('/:id', validateClient, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  // Increment view count
  campaign.views += 1;
  await campaign.save();

  const campaignObject = campaign.toObject();
  campaignObject.daysRemaining = campaign.daysRemaining;
  campaignObject.progressPercentage = campaign.progressPercentage;
  campaignObject.isExpired = campaign.isExpired;
  campaignObject.totalResponses = campaign.totalResponses;
  campaignObject.typeDisplay = campaign.typeDisplay;

  // Get preorder statistics for this campaign
  const preorderStats = await PreorderPledge.getCampaignStats(campaign._id);
  
  campaignObject.preorderStats = preorderStats;

  res.json({
    success: true,
    data: campaignObject
  });
}));

// Get campaign by ID (public view - no auth required)
router.get('/public/:campaignId', wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    $or: [
      { _id: req.params.campaignId },
      { campaignId: req.params.campaignId }
    ],
    status: 'active',
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  campaign.views += 1;
  await campaign.save();

  const campaignObject = campaign.toObject();
  campaignObject.daysRemaining = campaign.daysRemaining;
  campaignObject.progressPercentage = campaign.progressPercentage;
  campaignObject.totalResponses = campaign.totalResponses;
  campaignObject.typeDisplay = campaign.typeDisplay;

  // Get public stats based on campaign type
  let publicStats = {};
  
  if (campaign.campaignType === 'funding') {
    const stats = await PreorderPledge.aggregate([
      { $match: { 
        campaignId: campaign._id.toString(),
        isDeleted: false 
      }},
      { $group: {
        _id: '$isObligated',
        count: { $sum: 1 },
        totalAmount: { $sum: '$pledgeAmount' }
      }}
    ]);

    publicStats = {
      interested: stats.find(s => s._id === false)?.count || 0,
      backers: stats.find(s => s._id === true)?.count || 0,
      totalRaised: stats.find(s => s._id === true)?.totalAmount || 0
    };
  } else {
    // Interest campaign - just show total signups
    const count = await PreorderPledge.countDocuments({
      campaignId: campaign._id.toString(),
      isDeleted: false
    });
    
    publicStats = {
      totalInterested: count,
      uniqueSignups: campaign.uniqueSignupsCount
    };
  }

  campaignObject.publicStats = publicStats;

  res.json({
    success: true,
    data: campaignObject
  });
}));

// Update campaign
router.put('/:id', validateClient, wrapRoute(async (req, res) => {
  // Don't allow changing campaign type after creation
  if (req.body.campaignType) {
    delete req.body.campaignType;
  }

  const campaign = await Campaign.findOneAndUpdate(
    { 
      _id: req.params.id, 
      clientId: req.clientId 
    },
    { ...req.body, updatedAt: new Date() },
    { new: true, runValidators: true }
  );

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  res.json({
    success: true,
    data: campaign,
    message: 'Campaign updated successfully'
  });
}));

// Update campaign status
router.patch('/:id/status', validateClient, wrapRoute(async (req, res) => {
  const { status } = req.body;
  
  if (!['draft', 'active', 'paused', 'ended', 'cancelled'].includes(status)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid status'
    });
  }

  const campaign = await Campaign.findOneAndUpdate(
    { 
      _id: req.params.id, 
      clientId: req.clientId 
    },
    { status, updatedAt: new Date() },
    { new: true }
  );

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  res.json({
    success: true,
    data: campaign,
    message: `Campaign status updated to ${status}`
  });
}));

// Add reward tier (funding campaigns only)
router.post('/:id/rewards', validateClient, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    clientId: req.clientId
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  if (campaign.campaignType !== 'funding') {
    return res.status(400).json({
      success: false,
      error: 'Reward tiers can only be added to funding campaigns'
    });
  }

  const newTier = {
    tierId: 'TIER-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8).toUpperCase(),
    ...req.body,
    quantityClaimed: 0
  };

  campaign.rewardTiers.push(newTier);
  await campaign.save();

  res.status(201).json({
    success: true,
    data: newTier,
    message: 'Reward tier added successfully'
  });
}));

// Get campaign performance metrics
router.get('/:id/metrics', validateClient, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    clientId: req.clientId
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  const baseMetrics = {
    campaign: {
      name: campaign.name,
      type: campaign.campaignType,
      status: campaign.status,
      daysRemaining: campaign.daysRemaining,
      views: campaign.views,
      createdAt: campaign.createdAt
    }
  };

  if (campaign.campaignType === 'funding') {
    // Funding campaign metrics
    const pledgesOverTime = await PreorderPledge.aggregate([
      { $match: { campaignId: campaign._id.toString(), isDeleted: false } },
      {
        $group: {
          _id: {
            year: { $year: '$signupDate' },
            month: { $month: '$signupDate' },
            day: { $dayOfMonth: '$signupDate' },
            type: '$isObligated'
          },
          count: { $sum: 1 },
          amount: { $sum: '$pledgeAmount' }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    const rewardPerformance = await Promise.all(
      campaign.rewardTiers.map(async tier => {
        const pledges = await PreorderPledge.countDocuments({
          campaignId: campaign._id.toString(),
          'selectedRewards.rewardId': tier.tierId,
          isObligated: true
        });
        
        return {
          tierId: tier.tierId,
          name: tier.name,
          pledgeAmount: tier.pledgeAmount,
          quantity: tier.quantity,
          quantityClaimed: pledges,
          percentageFilled: tier.quantity ? (pledges / tier.quantity) * 100 : null
        };
      })
    );

    res.json({
      success: true,
      data: {
        ...baseMetrics,
        fundingMetrics: {
          amountRaised: campaign.amountRaised,
          fundingGoal: campaign.fundingGoal,
          progressPercentage: campaign.progressPercentage,
          backersCount: campaign.backersCount,
          interestedCount: campaign.interestedCount,
          averagePledge: campaign.backersCount > 0 ? campaign.amountRaised / campaign.backersCount : 0
        },
        pledgesOverTime,
        rewardPerformance
      }
    });
  } else {
    // Interest campaign metrics
    const signupsOverTime = await PreorderPledge.aggregate([
      { $match: { campaignId: campaign._id.toString(), isDeleted: false } },
      {
        $group: {
          _id: {
            year: { $year: '$signupDate' },
            month: { $month: '$signupDate' },
            day: { $dayOfMonth: '$signupDate' }
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ]);

    const interestBreakdown = await PreorderPledge.aggregate([
      { $match: { campaignId: campaign._id.toString(), isDeleted: false } },
      {
        $group: {
          _id: '$interestLevel',
          count: { $sum: 1 },
          expectedQuantity: { $sum: '$expectedQuantity' }
        }
      }
    ]);

    const sourceBreakdown = await PreorderPledge.aggregate([
      { $match: { campaignId: campaign._id.toString(), isDeleted: false } },
      {
        $group: {
          _id: '$source',
          count: { $sum: 1 }
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        ...baseMetrics,
        interestMetrics: {
          totalSignups: campaign.interestedCount,
          uniqueSignups: campaign.uniqueSignupsCount,
          conversionRate: campaign.uniqueSignupsCount > 0 
            ? (campaign.interestedCount / campaign.uniqueSignupsCount) * 100 
            : 0
        },
        signupsOverTime,
        interestBreakdown,
        sourceBreakdown
      }
    });
  }
}));

// Duplicate campaign
router.post('/:id/duplicate', validateClient, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    clientId: req.clientId
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  const campaignData = campaign.toObject();
  delete campaignData._id;
  delete campaignData.__v;
  delete campaignData.campaignId;
  delete campaignData.createdAt;
  delete campaignData.updatedAt;
  delete campaignData.views;
  delete campaignData.backersCount;
  delete campaignData.amountRaised;
  delete campaignData.interestedCount;
  delete campaignData.uniqueSignupsCount;
  
  campaignData.name = `${campaignData.name} (Copy)`;
  campaignData.status = 'draft';
  campaignData.startDate = new Date();
  campaignData.endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now

  const newCampaign = new Campaign(campaignData);
  await newCampaign.save();

  res.status(201).json({
    success: true,
    data: newCampaign,
    message: 'Campaign duplicated successfully'
  });
}));

// Delete cover image
router.delete('/:id/cover', validateClient, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  if (campaign.media && campaign.media.coverImage) {
    const imagePath = campaign.media.coverImage.replace(/^.*[\\\/]uploads[\\\/]/, 'uploads/');
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
    
    campaign.media.coverImage = null;
    await campaign.save();
  }

  res.json({
    success: true,
    message: 'Cover image deleted successfully'
  });
}));

// Delete gallery image
router.delete('/:id/gallery/:imageIndex', validateClient, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  const imageIndex = parseInt(req.params.imageIndex);
  
  if (campaign.media && campaign.media.gallery && campaign.media.gallery[imageIndex]) {
    const imagePath = campaign.media.gallery[imageIndex].url.replace(/^.*[\\\/]uploads[\\\/]/, 'uploads/');
    if (fs.existsSync(imagePath)) {
      fs.unlinkSync(imagePath);
    }
    
    campaign.media.gallery.splice(imageIndex, 1);
    await campaign.save();
  }

  res.json({
    success: true,
    message: 'Gallery image deleted successfully'
  });
}));

// Soft delete campaign
router.delete('/:id', validateClient, requireAdmin, wrapRoute(async (req, res) => {
  const campaign = await Campaign.findOneAndUpdate(
    { 
      _id: req.params.id, 
      clientId: req.clientId 
    },
    { isDeleted: true, updatedAt: new Date() },
    { new: true }
  );

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  res.json({
    success: true,
    message: 'Campaign deleted successfully'
  });
}));

module.exports = router;