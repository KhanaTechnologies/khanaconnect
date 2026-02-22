// routes/votingCampaigns.js
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const VotingCampaign = require('../models/VotingCampaign');
const Vote = require('../models/Vote');
const Customer = require('../models/customer');
const { body, validationResult } = require('express-validator');
const { wrapRoute } = require('../helpers/failureEmail');

// Ensure upload directories exist
const uploadDirs = ['uploads/voting', 'uploads/voting/temp', 'uploads/voting/items'];
uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Store in temp directory first for processing
    cb(null, 'uploads/voting/temp');
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, 'vote-' + uniqueSuffix + ext);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /\.(jpg|JPG|jpeg|JPEG|png|PNG|gif|GIF|webp|WEBP)$/;
  if (!file.originalname.match(allowedTypes)) {
    req.fileValidationError = 'Only image files are allowed (jpg, png, gif, webp)';
    return cb(new Error('Only image files are allowed'), false);
  }
  cb(null, true);
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB limit for voting images
  },
  fileFilter: fileFilter
});

// Image processing middleware
const processImage = async (req, res, next) => {
  if (!req.file) return next();
  
  try {
    const filePath = req.file.path;
    const fileName = req.file.filename;
    const baseName = path.parse(fileName).name;
    const outputDir = 'uploads/voting/items';
    
    // Get image metadata
    const metadata = await sharp(filePath).metadata();
    
    // Create thumbnail (300x300, crop to square)
    const thumbnailPath = path.join(outputDir, 'thumb-' + fileName.replace(/\.[^/.]+$/, '.jpg'));
    await sharp(filePath)
      .resize(300, 300, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 80 })
      .toFile(thumbnailPath);
    
    // Create medium size (800x800, maintain aspect ratio)
    const mediumPath = path.join(outputDir, 'medium-' + fileName.replace(/\.[^/.]+$/, '.jpg'));
    await sharp(filePath)
      .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toFile(mediumPath);
    
    // Move original to items folder with proper name
    const originalPath = path.join(outputDir, 'orig-' + fileName.replace(/\.[^/.]+$/, '.jpg'));
    await sharp(filePath)
      .jpeg({ quality: 90 })
      .toFile(originalPath);
    
    // Clean up temp file
    fs.unlinkSync(filePath);
    
    req.processedImage = {
      url: `/uploads/voting/items/medium-${fileName.replace(/\.[^/.]+$/, '.jpg')}`,
      thumbnail: `/uploads/voting/items/thumb-${fileName.replace(/\.[^/.]+$/, '.jpg')}`,
      original: `/uploads/voting/items/orig-${fileName.replace(/\.[^/.]+$/, '.jpg')}`,
      filename: fileName,
      width: metadata.width,
      height: metadata.height,
      format: 'jpeg',
      size: req.file.size
    };
    
    next();
  } catch (error) {
    console.error('Image processing error:', error);
    // Clean up temp file if processing fails
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    next(error);
  }
};

// Middleware to authenticate client
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

// Middleware to authenticate customer (for voting)
const validateCustomer = (req, res, next) => {
  const token = req.headers.authorization;
  if (!token || !token.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - Customer token missing' });
  }

  const tokenValue = token.split(' ')[1];
  jwt.verify(tokenValue, process.env.JWT_SECRET || process.env.secret, (err, decoded) => {
    if (err || !decoded.customerID) {
      return res.status(403).json({ error: 'Forbidden - Invalid customer token' });
    }
    req.customerId = decoded.customerID;
    req.clientId = decoded.clientID;
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

// Validation rules
const campaignValidation = [
  body('title').notEmpty().withMessage('Campaign title is required'),
  body('description').notEmpty().withMessage('Description is required'),
  body('campaignType').isIn(['campaign', 'poll']).withMessage('Valid campaign type required'),
  body('startDate').isISO8601().withMessage('Valid start date is required'),
  body('endDate').isISO8601().withMessage('Valid end date is required'),
  body('items').isArray({ min: 2 }).withMessage('At least 2 voting items are required'),
  body('items.*.title').notEmpty().withMessage('Each item must have a title')
];

// ==================== VOTING CAMPAIGN MANAGEMENT ====================

// Create a new voting campaign
router.post('/', validateClient, campaignValidation, wrapRoute(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }

  // Add client info
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
    req.body.campaignStatus = 'active';
  } else if (startDate > now) {
    req.body.campaignStatus = 'draft';
  }

  // Initialize media if not provided
  if (!req.body.media) {
    req.body.media = {};
  }

  // Initialize images array and image-related fields for each item
  if (req.body.items) {
    req.body.items = req.body.items.map(item => ({
      ...item,
      images: [],
      mainImage: null,
      thumbnail: null,
      displaySettings: {
        imageFit: 'cover',
        showCaption: false,
        imageAspectRatio: '1:1',
        ...item.displaySettings
      }
    }));
  }

  const campaign = new VotingCampaign(req.body);
  await campaign.save();

  res.status(201).json({
    success: true,
    data: campaign,
    message: `${campaign.campaignType} created successfully`
  });
}));

// Upload cover image for campaign
router.post('/:id/upload-cover', validateClient, upload.single('coverImage'), processImage, wrapRoute(async (req, res) => {
  if (req.fileValidationError) {
    return res.status(400).json({
      success: false,
      error: req.fileValidationError
    });
  }

  if (!req.file && !req.processedImage) {
    return res.status(400).json({
      success: false,
      error: 'No image file provided'
    });
  }

  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    // Clean up uploaded files
    if (req.processedImage) {
      ['url', 'thumbnail', 'original'].forEach(key => {
        if (req.processedImage[key]) {
          const filePath = req.processedImage[key].replace('/uploads/voting/items/', 'uploads/voting/items/');
          if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        }
      });
    }
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  // Delete old cover image if exists
  if (campaign.media && campaign.media.coverImage) {
    const oldImagePath = campaign.media.coverImage.replace('/uploads/voting/', 'uploads/voting/');
    if (fs.existsSync(oldImagePath)) {
      fs.unlinkSync(oldImagePath);
    }
    // Also delete thumbnails if they exist
    const oldThumbPath = oldImagePath.replace(/medium-/, 'thumb-');
    if (fs.existsSync(oldThumbPath)) fs.unlinkSync(oldThumbPath);
    const oldOrigPath = oldImagePath.replace(/medium-/, 'orig-');
    if (fs.existsSync(oldOrigPath)) fs.unlinkSync(oldOrigPath);
  }

  // Update campaign with new cover image
  campaign.media.coverImage = req.processedImage.url;
  campaign.media.coverImagePublicId = req.processedImage.filename;
  await campaign.save();

  res.json({
    success: true,
    data: {
      coverImage: campaign.media.coverImage,
      thumbnail: req.processedImage.thumbnail,
      original: req.processedImage.original
    },
    message: 'Cover image uploaded successfully'
  });
}));

// ==================== VOTING ITEMS IMAGE MANAGEMENT ====================

// Upload image for a specific voting item
router.post('/:id/items/:itemId/images', validateClient, upload.single('image'), processImage, wrapRoute(async (req, res) => {
  if (req.fileValidationError) {
    return res.status(400).json({
      success: false,
      error: req.fileValidationError
    });
  }

  if (!req.processedImage) {
    return res.status(400).json({
      success: false,
      error: 'No image file provided or processing failed'
    });
  }

  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    // Clean up uploaded files
    ['url', 'thumbnail', 'original'].forEach(key => {
      if (req.processedImage[key]) {
        const filePath = req.processedImage[key].replace('/uploads/voting/items/', 'uploads/voting/items/');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    });
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  const item = campaign.items.find(i => 
    i.itemId === req.params.itemId || i._id.toString() === req.params.itemId
  );
  
  if (!item) {
    // Clean up uploaded files
    ['url', 'thumbnail', 'original'].forEach(key => {
      if (req.processedImage[key]) {
        const filePath = req.processedImage[key].replace('/uploads/voting/items/', 'uploads/voting/items/');
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    });
    return res.status(404).json({
      success: false,
      message: 'Item not found'
    });
  }

  // Prepare image data
  const imageData = {
    url: req.processedImage.url,
    thumbnail: req.processedImage.thumbnail,
    medium: req.processedImage.url,
    original: req.processedImage.original,
    publicId: req.processedImage.filename,
    caption: req.body.caption || '',
    isPrimary: item.images.length === 0, // First image is primary by default
    order: item.images.length,
    dimensions: {
      width: req.processedImage.width || 0,
      height: req.processedImage.height || 0
    },
    fileSize: req.processedImage.size,
    format: req.processedImage.format
  };

  // Add image to item
  await campaign.addItemImage(item.itemId || item._id, imageData);

  // Get updated item with images
  const updatedItem = campaign.getItemWithImages(item.itemId || item._id);

  res.status(201).json({
    success: true,
    data: {
      image: imageData,
      item: {
        itemId: updatedItem.itemId,
        title: updatedItem.title,
        imageCount: updatedItem.images.length,
        mainImage: updatedItem.mainImage,
        thumbnail: updatedItem.thumbnail,
        hasImages: updatedItem.hasImages
      }
    },
    message: 'Image uploaded successfully'
  });
}));

// Upload multiple images for an item
router.post('/:id/items/:itemId/images/bulk', validateClient, upload.array('images', 10), wrapRoute(async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'No images provided'
    });
  }

  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    // Clean up uploaded files
    req.files.forEach(file => {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    });
    return res.status(404).json({
      success: false,
      message: 'Campaign not found'
    });
  }

  const item = campaign.items.find(i => 
    i.itemId === req.params.itemId || i._id.toString() === req.params.itemId
  );
  
  if (!item) {
    // Clean up uploaded files
    req.files.forEach(file => {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    });
    return res.status(404).json({
      success: false,
      message: 'Item not found'
    });
  }

  const uploadedImages = [];
  const errors = [];

  // Process each image
  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    try {
      // Create a mock req for processImage
      const mockReq = { file, body: { caption: req.body.captions ? req.body.captions[i] : '' } };
      const mockRes = {};
      
      // Manually process the image
      const metadata = await sharp(file.path).metadata();
      const fileName = file.filename;
      const outputDir = 'uploads/voting/items';
      
      // Create thumbnail
      const thumbnailPath = path.join(outputDir, 'thumb-' + fileName.replace(/\.[^/.]+$/, '.jpg'));
      await sharp(file.path)
        .resize(300, 300, { fit: 'cover' })
        .jpeg({ quality: 80 })
        .toFile(thumbnailPath);
      
      // Create medium size
      const mediumPath = path.join(outputDir, 'medium-' + fileName.replace(/\.[^/.]+$/, '.jpg'));
      await sharp(file.path)
        .resize(800, 800, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toFile(mediumPath);
      
      // Create original
      const originalPath = path.join(outputDir, 'orig-' + fileName.replace(/\.[^/.]+$/, '.jpg'));
      await sharp(file.path)
        .jpeg({ quality: 90 })
        .toFile(originalPath);
      
      // Clean up temp file
      fs.unlinkSync(file.path);

      const imageData = {
        url: `/uploads/voting/items/medium-${fileName.replace(/\.[^/.]+$/, '.jpg')}`,
        thumbnail: `/uploads/voting/items/thumb-${fileName.replace(/\.[^/.]+$/, '.jpg')}`,
        medium: `/uploads/voting/items/medium-${fileName.replace(/\.[^/.]+$/, '.jpg')}`,
        original: `/uploads/voting/items/orig-${fileName.replace(/\.[^/.]+$/, '.jpg')}`,
        publicId: fileName,
        caption: req.body.captions ? req.body.captions[i] : '',
        isPrimary: item.images.length === 0 && uploadedImages.length === 0,
        order: item.images.length + uploadedImages.length,
        dimensions: {
          width: metadata.width,
          height: metadata.height
        },
        fileSize: file.size,
        format: 'jpeg'
      };

      await campaign.addItemImage(item.itemId || item._id, imageData);
      uploadedImages.push(imageData);
    } catch (error) {
      errors.push({ file: file.originalname, error: error.message });
      // Clean up failed file
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    }
  }

  const updatedItem = campaign.getItemWithImages(item.itemId || item._id);

  res.json({
    success: true,
    data: {
      uploaded: uploadedImages,
      errors: errors,
      item: {
        itemId: updatedItem.itemId,
        title: updatedItem.title,
        totalImages: updatedItem.images.length,
        mainImage: updatedItem.mainImage,
        thumbnail: updatedItem.thumbnail,
        hasImages: updatedItem.hasImages
      }
    },
    message: `${uploadedImages.length} images uploaded successfully`
  });
}));

// Get all images for an item
router.get('/:id/items/:itemId/images', validateClient, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
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

  const item = campaign.getItemWithImages(req.params.itemId);
  
  if (!item) {
    return res.status(404).json({
      success: false,
      message: 'Item not found'
    });
  }

  res.json({
    success: true,
    data: {
      itemId: item.itemId,
      title: item.title,
      images: item.images.map(img => ({
        ...img,
        isPrimary: img.isPrimary
      })),
      mainImage: item.mainImage,
      thumbnail: item.thumbnail,
      imageCount: item.images.length,
      hasImages: item.hasImages
    }
  });
}));

// Set primary image for an item
router.patch('/:id/items/:itemId/images/primary', validateClient, wrapRoute(async (req, res) => {
  const { imageUrl } = req.body;
  
  if (!imageUrl) {
    return res.status(400).json({
      success: false,
      error: 'Image URL is required'
    });
  }

  const campaign = await VotingCampaign.findOne({
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

  const item = campaign.items.find(i => 
    i.itemId === req.params.itemId || i._id.toString() === req.params.itemId
  );
  
  if (!item) {
    return res.status(404).json({
      success: false,
      message: 'Item not found'
    });
  }

  await campaign.setPrimaryImage(item.itemId || item._id, imageUrl);

  const updatedItem = campaign.getItemWithImages(item.itemId || item._id);

  res.json({
    success: true,
    message: 'Primary image set successfully',
    data: {
      itemId: updatedItem.itemId,
      primaryImage: updatedItem.mainImage,
      thumbnail: updatedItem.thumbnail,
      hasImages: updatedItem.hasImages
    }
  });
}));

// Delete image from item
router.delete('/:id/items/:itemId/images', validateClient, wrapRoute(async (req, res) => {
  const { imageUrl } = req.body;
  
  if (!imageUrl) {
    return res.status(400).json({
      success: false,
      error: 'Image URL is required'
    });
  }

  const campaign = await VotingCampaign.findOne({
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

  const item = campaign.items.find(i => 
    i.itemId === req.params.itemId || i._id.toString() === req.params.itemId
  );
  
  if (!item) {
    return res.status(404).json({
      success: false,
      message: 'Item not found'
    });
  }

  // Delete physical files
  const imagePath = imageUrl.replace('/uploads/voting/items/', 'uploads/voting/items/');
  if (fs.existsSync(imagePath)) {
    fs.unlinkSync(imagePath);
  }
  
  // Delete thumbnail if exists
  const thumbPath = imagePath.replace('medium-', 'thumb-');
  if (fs.existsSync(thumbPath)) {
    fs.unlinkSync(thumbPath);
  }
  
  // Delete original
  const originalPath = imagePath.replace('medium-', 'orig-');
  if (fs.existsSync(originalPath)) {
    fs.unlinkSync(originalPath);
  }

  await campaign.removeItemImage(item.itemId || item._id, imageUrl);

  const updatedItem = campaign.getItemWithImages(item.itemId || item._id);

  res.json({
    success: true,
    message: 'Image deleted successfully',
    data: {
      itemId: updatedItem.itemId,
      remainingImages: updatedItem.images.length,
      mainImage: updatedItem.mainImage,
      thumbnail: updatedItem.thumbnail,
      hasImages: updatedItem.hasImages
    }
  });
}));

// Reorder images for an item
router.patch('/:id/items/:itemId/images/reorder', validateClient, wrapRoute(async (req, res) => {
  const { imageUrls } = req.body;
  
  if (!imageUrls || !Array.isArray(imageUrls) || imageUrls.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Image URLs array is required'
    });
  }

  const campaign = await VotingCampaign.findOne({
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

  const item = campaign.items.find(i => 
    i.itemId === req.params.itemId || i._id.toString() === req.params.itemId
  );
  
  if (!item) {
    return res.status(404).json({
      success: false,
      message: 'Item not found'
    });
  }

  await campaign.reorderImages(item.itemId || item._id, imageUrls);

  const updatedItem = campaign.getItemWithImages(item.itemId || item._id);

  res.json({
    success: true,
    message: 'Images reordered successfully',
    data: {
      itemId: updatedItem.itemId,
      images: updatedItem.images.map(img => ({
        url: img.url,
        thumbnail: img.thumbnail,
        order: img.order,
        isPrimary: img.isPrimary
      }))
    }
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

  if (status) filter.campaignStatus = status;
  if (campaignType) filter.campaignType = campaignType;
  if (category) filter.categories = { $in: [category] };
  if (search) {
    filter.$or = [
      { title: { $regex: search, $options: 'i' } },
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

  const campaigns = await VotingCampaign.find(filter)
    .sort(sort)
    .limit(parseInt(limit))
    .skip(skip);

  const total = await VotingCampaign.countDocuments(filter);

  // Add virtuals
  const campaignsWithVirtuals = campaigns.map(c => {
    const obj = c.toObject();
    obj.daysRemaining = c.daysRemaining;
    obj.hoursRemaining = c.hoursRemaining;
    obj.isExpired = c.isExpired;
    obj.campaignActive = c.campaignActive;
    obj.itemsWithStats = c.itemsWithStats;
    obj.itemsWithImages = c.itemsWithImages;
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

// Get campaigns by type
router.get('/type/:type', validateClient, wrapRoute(async (req, res) => {
  const { type } = req.params;
  
  if (!['campaign', 'poll'].includes(type)) {
    return res.status(400).json({
      success: false,
      error: 'Invalid campaign type'
    });
  }

  const campaigns = await VotingCampaign.find({
    clientId: req.clientId,
    campaignType: type,
    isDeleted: false
  }).sort({ createdAt: -1 });

  const campaignsWithImages = campaigns.map(c => ({
    ...c.toObject(),
    itemsWithImages: c.itemsWithImages
  }));

  res.json({
    success: true,
    data: campaignsWithImages,
    count: campaigns.length,
    type
  });
}));

// Get active voting campaigns
router.get('/active', validateClient, wrapRoute(async (req, res) => {
  const { type } = req.query;
  
  const campaigns = await VotingCampaign.findActiveByClient(req.clientId, type);
  
  const campaignsWithVirtuals = campaigns.map(c => {
    const obj = c.toObject();
    obj.daysRemaining = c.daysRemaining;
    obj.hoursRemaining = c.hoursRemaining;
    obj.itemsWithStats = c.itemsWithStats;
    obj.itemsWithImages = c.itemsWithImages;
    return obj;
  });

  res.json({
    success: true,
    data: campaignsWithVirtuals,
    count: campaigns.length
  });
}));

// Get single voting campaign by ID
router.get('/:id', validateClient, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  // Increment view count
  await campaign.incrementView();

  const campaignObject = campaign.toObject();
  campaignObject.daysRemaining = campaign.daysRemaining;
  campaignObject.hoursRemaining = campaign.hoursRemaining;
  campaignObject.isExpired = campaign.isExpired;
  campaignObject.campaignActive = campaign.campaignActive;
  campaignObject.itemsWithStats = campaign.itemsWithStats;
  campaignObject.itemsWithImages = campaign.itemsWithImages;
  campaignObject.winningItem = campaign.getWinningItem();

  res.json({
    success: true,
    data: campaignObject
  });
}));

// Update campaign
router.put('/:id', validateClient, wrapRoute(async (req, res) => {
  // Don't allow changing campaign type
  if (req.body.campaignType) {
    delete req.body.campaignType;
  }

  const campaign = await VotingCampaign.findOneAndUpdate(
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
      message: 'Voting campaign not found'
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

  const campaign = await VotingCampaign.findOneAndUpdate(
    { 
      _id: req.params.id, 
      clientId: req.clientId 
    },
    { campaignStatus: status, updatedAt: new Date() },
    { new: true }
  );

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  res.json({
    success: true,
    data: campaign,
    message: `Campaign status updated to ${status}`
  });
}));

// Add item to campaign
router.post('/:id/items', validateClient, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  const newItem = {
    itemId: 'ITEM-' + Date.now() + '-' + Math.random().toString(36).substr(2, 8).toUpperCase(),
    ...req.body,
    votesCount: 0,
    images: [],
    mainImage: null,
    thumbnail: null,
    displaySettings: {
      imageFit: 'cover',
      showCaption: false,
      imageAspectRatio: '1:1',
      ...req.body.displaySettings
    }
  };

  campaign.items.push(newItem);
  await campaign.save();

  res.status(201).json({
    success: true,
    data: newItem,
    message: 'Item added successfully'
  });
}));

// Update item
router.put('/:id/items/:itemId', validateClient, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  const item = campaign.items.find(i => 
    i.itemId === req.params.itemId || i._id.toString() === req.params.itemId
  );
  
  if (!item) {
    return res.status(404).json({
      success: false,
      message: 'Item not found'
    });
  }

  // Preserve images and votes
  const { images, votesCount, mainImage, thumbnail, ...updatableFields } = req.body;
  Object.assign(item, updatableFields);
  
  await campaign.save();

  res.json({
    success: true,
    data: campaign.getItemWithImages(item.itemId || item._id),
    message: 'Item updated successfully'
  });
}));

// Delete item (only if no votes)
router.delete('/:id/items/:itemId', validateClient, requireAdmin, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  const item = campaign.items.find(i => 
    i.itemId === req.params.itemId || i._id.toString() === req.params.itemId
  );
  
  if (!item) {
    return res.status(404).json({
      success: false,
      message: 'Item not found'
    });
  }

  if (item.votesCount > 0) {
    return res.status(400).json({
      success: false,
      error: 'Cannot delete item that has received votes'
    });
  }

  // Delete all images for this item
  if (item.images && item.images.length > 0) {
    item.images.forEach(image => {
      const imagePath = image.url.replace('/uploads/voting/items/', 'uploads/voting/items/');
      if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
      
      const thumbPath = imagePath.replace('medium-', 'thumb-');
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      
      const originalPath = imagePath.replace('medium-', 'orig-');
      if (fs.existsSync(originalPath)) fs.unlinkSync(originalPath);
    });
  }

  campaign.items = campaign.items.filter(i => 
    !(i.itemId === req.params.itemId || i._id.toString() === req.params.itemId)
  );
  
  await campaign.save();

  res.json({
    success: true,
    message: 'Item deleted successfully'
  });
}));

// Get campaign results
router.get('/:id/results', validateClient, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  const results = campaign.getResults();
  
  // Get detailed vote stats
  const voteStats = await Vote.getCampaignStats(campaign._id);

  res.json({
    success: true,
    data: {
      campaign: {
        id: campaign._id,
        title: campaign.title,
        type: campaign.campaignType,
        status: campaign.campaignStatus,
        totalVotes: campaign.totalVotes,
        uniqueVoters: campaign.uniqueVoters
      },
      results,
      voteStats
    }
  });
}));

// Get campaign statistics
router.get('/:id/stats', validateClient, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId,
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  // Get vote statistics
  const voteStats = await Vote.getCampaignStats(campaign._id);

  // Get voter list (paginated)
  const voters = await Vote.find({ 
    campaignId: campaign._id,
    isDeleted: false,
    status: 'active'
  })
    .populate('customerId', 'customerFirstName customerLastName emailAddress')
    .select('-__v')
    .sort({ votedAt: -1 })
    .limit(100);

  res.json({
    success: true,
    data: {
      campaign: {
        id: campaign._id,
        title: campaign.title,
        type: campaign.campaignType,
        status: campaign.campaignStatus,
        views: campaign.views,
        totalVotes: campaign.totalVotes,
        uniqueVoters: campaign.uniqueVoters,
        startDate: campaign.startDate,
        endDate: campaign.endDate,
        daysRemaining: campaign.daysRemaining
      },
      voteStats,
      recentVoters: voters.map(v => ({
        voteId: v.voteId,
        customer: v.customerId,
        itemId: v.itemId,
        itemTitle: v.itemTitle,
        itemImage: v.itemImageAtVote,
        votedAt: v.votedAt
      }))
    }
  });
}));

// Duplicate campaign
router.post('/:id/duplicate', validateClient, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
    _id: req.params.id,
    clientId: req.clientId
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  const campaignData = campaign.toObject();
  delete campaignData._id;
  delete campaignData.__v;
  delete campaignData.campaignId;
  delete campaignData.createdAt;
  delete campaignData.updatedAt;
  delete campaignData.views;
  delete campaignData.totalVotes;
  delete campaignData.uniqueVoters;
  
  // Reset item votes but keep images
  campaignData.items = campaignData.items.map(item => ({
    ...item,
    votesCount: 0
  }));
  
  campaignData.title = `${campaignData.title} (Copy)`;
  campaignData.campaignStatus = 'draft';
  campaignData.startDate = new Date();
  campaignData.endDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

  const newCampaign = new VotingCampaign(campaignData);
  await newCampaign.save();

  res.status(201).json({
    success: true,
    data: newCampaign,
    message: 'Campaign duplicated successfully'
  });
}));

// Soft delete campaign
router.delete('/:id', validateClient, requireAdmin, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOneAndUpdate(
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
      message: 'Voting campaign not found'
    });
  }

  // Soft delete all associated votes
  await Vote.updateMany(
    { campaignId: campaign._id },
    { isDeleted: true }
  );

  res.json({
    success: true,
    message: 'Campaign deleted successfully'
  });
}));

// ==================== PUBLIC VOTING ENDPOINTS ====================

// Get public campaign view
router.get('/public/:id', wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
    $or: [
      { _id: req.params.id },
      { campaignId: req.params.id }
    ],
    campaignStatus: 'active',
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found or not active'
    });
  }

  await campaign.incrementView();

  // Prepare public data with images
  const publicData = {
    id: campaign._id,
    campaignId: campaign.campaignId,
    title: campaign.title,
    description: campaign.description,
    shortDescription: campaign.shortDescription,
    campaignType: campaign.campaignType,
    items: campaign.itemsWithImages.map(item => ({
      itemId: item.itemId,
      title: item.title,
      description: item.description,
      images: item.images.map(img => ({
        url: img.url,
        thumbnail: img.thumbnail,
        caption: img.caption,
        isPrimary: img.isPrimary
      })),
      mainImage: item.mainImage,
      thumbnail: item.thumbnail,
      hasImages: item.hasImages,
      icon: item.icon,
      votesCount: campaign.votingRules.resultsVisibility === 'public' ? item.votesCount : null,
      percentage: campaign.votingRules.resultsVisibility === 'public' ? 
        (campaign.totalVotes > 0 ? Math.round((item.votesCount / campaign.totalVotes) * 100) : 0) : null,
      displaySettings: item.displaySettings
    })),
    startDate: campaign.startDate,
    endDate: campaign.endDate,
    daysRemaining: campaign.daysRemaining,
    hoursRemaining: campaign.hoursRemaining,
    totalVotes: campaign.votingRules.resultsVisibility === 'public' ? campaign.totalVotes : null,
    media: {
      coverImage: campaign.media?.coverImage,
      gallery: campaign.media?.gallery
    },
    settings: {
      requireLogin: campaign.settings.requireLogin,
      showProgressBar: campaign.settings.showProgressBar,
      showLeaderboard: campaign.settings.showLeaderboard,
      visualSettings: campaign.settings.visualSettings
    },
    votingRules: {
      allowMultipleVotes: campaign.votingRules.allowMultipleVotes,
      maxVotesPerCustomer: campaign.votingRules.maxVotesPerCustomer,
      voteChangeAllowed: campaign.votingRules.voteChangeAllowed,
      resultsVisibility: campaign.votingRules.resultsVisibility
    }
  };

  res.json({
    success: true,
    data: publicData
  });
}));

// Cast a vote
router.post('/public/:id/vote', validateCustomer, wrapRoute(async (req, res) => {
  const { itemId } = req.body;
  
  if (!itemId) {
    return res.status(400).json({
      success: false,
      error: 'Item ID is required'
    });
  }

  // Get campaign
  const campaign = await VotingCampaign.findOne({
    $or: [
      { _id: req.params.id },
      { campaignId: req.params.id }
    ],
    campaignStatus: 'active',
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found or not active'
    });
  }

  // Check if campaign requires login
  if (campaign.settings.requireLogin && !req.customerId) {
    return res.status(401).json({
      success: false,
      error: 'Login required to vote'
    });
  }

  // Find the item
  const item = campaign.items.find(i => 
    i.itemId === itemId || i._id.toString() === itemId
  );
  
  if (!item) {
    return res.status(404).json({
      success: false,
      error: 'Voting item not found'
    });
  }

  // Get customer details
  const customer = await Customer.findById(req.customerId);
  if (!customer) {
    return res.status(404).json({
      success: false,
      error: 'Customer not found'
    });
  }

  // Check if customer has already voted
  const hasVoted = await Vote.hasVoted(campaign._id, req.customerId);
  
  if (hasVoted && !campaign.votingRules.allowMultipleVotes) {
    // Check if they want to change their vote
    if (campaign.votingRules.voteChangeAllowed) {
      const existingVote = await Vote.findOne({
        campaignId: campaign._id,
        customerId: req.customerId,
        isDeleted: false,
        status: 'active'
      });

      if (existingVote) {
        // Check if they're voting for the same item
        if (existingVote.itemId === itemId) {
          return res.status(400).json({
            success: false,
            error: 'You have already voted for this item',
            canChange: true
          });
        }

        // Get the item image
        const itemImage = item.mainImage || item.thumbnail || null;

        // Change the vote
        await existingVote.changeVote(item.itemId || item._id, item.title, itemImage);
        
        // Get updated campaign
        const updatedCampaign = await VotingCampaign.findById(campaign._id);
        
        return res.json({
          success: true,
          message: 'Your vote has been changed successfully',
          data: {
            voteId: existingVote.voteId,
            itemId: existingVote.itemId,
            itemTitle: existingVote.itemTitle,
            itemImage: existingVote.itemImageAtVote,
            votedAt: existingVote.votedAt,
            totalVotes: updatedCampaign.totalVotes,
            previousVotes: existingVote.previousVotes
          }
        });
      }
    }

    return res.status(400).json({
      success: false,
      error: 'You have already voted in this campaign',
      canChange: campaign.votingRules.voteChangeAllowed
    });
  }

  if (hasVoted && campaign.votingRules.allowMultipleVotes) {
    const voteCount = await Vote.getVoteCount(campaign._id, req.customerId);
    if (voteCount >= campaign.votingRules.maxVotesPerCustomer) {
      return res.status(400).json({
        success: false,
        error: `Maximum votes (${campaign.votingRules.maxVotesPerCustomer}) reached`
      });
    }
  }

  // Get item image for vote record
  const itemImage = item.mainImage || item.thumbnail || null;

  // Create new vote
  const vote = new Vote({
    campaignId: campaign._id,
    itemId: item.itemId || item._id,
    itemTitle: item.title,
    itemImageAtVote: itemImage,
    customerId: req.customerId,
    customerInfo: {
      name: `${customer.customerFirstName} ${customer.customerLastName}`,
      email: customer.emailAddress
    },
    clientId: req.clientId,
    ipAddress: req.ip,
    userAgent: req.get('User-Agent'),
    source: req.body.source || 'web'
  });

  await vote.save();

  // Get updated campaign stats
  const updatedCampaign = await VotingCampaign.findById(campaign._id);

  res.status(201).json({
    success: true,
    message: 'Vote cast successfully',
    data: {
      voteId: vote.voteId,
      campaignId: campaign.campaignId,
      itemId: vote.itemId,
      itemTitle: vote.itemTitle,
      itemImage: itemImage,
      votedAt: vote.votedAt,
      totalVotes: updatedCampaign.totalVotes
    }
  });
}));

// Get customer's vote status
router.get('/public/:id/my-vote', validateCustomer, wrapRoute(async (req, res) => {
  const campaign = await VotingCampaign.findOne({
    $or: [
      { _id: req.params.id },
      { campaignId: req.params.id }
    ],
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  const voteStatus = await VotingCampaign.checkCustomerVote(campaign._id, req.customerId);

  // If they have voted, get the item details including image
  let votedItem = null;
  if (voteStatus.hasVoted && voteStatus.vote) {
    const item = campaign.items.find(i => 
      i.itemId === voteStatus.vote.itemId || i._id.toString() === voteStatus.vote.itemId
    );
    
    if (item) {
      votedItem = {
        itemId: item.itemId || item._id,
        title: item.title,
        image: item.mainImage || item.thumbnail,
        description: item.description,
        hasImages: item.images && item.images.length > 0
      };
    }
  }

  res.json({
    success: true,
    data: {
      campaignId: campaign.campaignId,
      campaignTitle: campaign.title,
      ...voteStatus,
      votedItem
    }
  });
}));

// Get customer's vote history
router.get('/customer/votes', validateCustomer, wrapRoute(async (req, res) => {
  const votes = await Vote.getCustomerVotes(req.customerId);

  // Enhance with campaign and item images
  const enhancedVotes = await Promise.all(votes.map(async (vote) => {
    const campaign = await VotingCampaign.findById(vote.campaignId);
    let itemImage = vote.itemImageAtVote;
    
    if (!itemImage && campaign) {
      const item = campaign.items.find(i => 
        i.itemId === vote.itemId || i._id.toString() === vote.itemId
      );
      if (item) {
        itemImage = item.mainImage || item.thumbnail;
      }
    }
    
    return {
      ...vote.toObject(),
      itemImage,
      campaignTitle: vote.campaignId?.title,
      campaignType: vote.campaignId?.campaignType
    };
  }));

  res.json({
    success: true,
    data: enhancedVotes,
    count: enhancedVotes.length
  });
}));

// Cancel vote (if allowed)
router.delete('/public/:id/vote', validateCustomer, wrapRoute(async (req, res) => {
  const { reason } = req.body;

  const campaign = await VotingCampaign.findOne({
    $or: [
      { _id: req.params.id },
      { campaignId: req.params.id }
    ],
    campaignStatus: 'active',
    isDeleted: false
  });

  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: 'Voting campaign not found'
    });
  }

  const vote = await Vote.findOne({
    campaignId: campaign._id,
    customerId: req.customerId,
    isDeleted: false,
    status: 'active'
  });

  if (!vote) {
    return res.status(404).json({
      success: false,
      error: 'No active vote found'
    });
  }

  // Check if vote change is allowed
  if (!campaign.votingRules.voteChangeAllowed) {
    return res.status(400).json({
      success: false,
      error: 'Vote cancellation is not allowed for this campaign'
    });
  }

  await vote.cancel(reason);

  res.json({
    success: true,
    message: 'Vote cancelled successfully'
  });
}));

// ==================== ANALYTICS ====================

// Get client voting statistics
router.get('/analytics/overview', validateClient, wrapRoute(async (req, res) => {
  const stats = await VotingCampaign.getClientStats(req.clientId);
  
  // Get overall vote activity
  const voteActivity = await Vote.aggregate([
    { $match: { clientId: req.clientId, isDeleted: false, status: 'active' } },
    { $group: {
      _id: {
        year: { $year: '$votedAt' },
        month: { $month: '$votedAt' },
        day: { $dayOfMonth: '$votedAt' }
      },
      count: { $sum: 1 }
    }},
    { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } },
    { $limit: 30 }
  ]);

  // Get top performing campaigns
  const topCampaigns = await VotingCampaign.aggregate([
    { $match: { clientId: req.clientId, isDeleted: false } },
    { $project: {
      title: 1,
      campaignType: 1,
      totalVotes: 1,
      uniqueVoters: 1,
      views: 1,
      itemCount: { $size: '$items' },
      itemsWithImages: {
        $size: {
          $filter: {
            input: '$items',
            as: 'item',
            cond: { $gt: [{ $size: { $ifNull: ['$$item.images', []] } }, 0] }
          }
        }
      },
      conversionRate: {
        $cond: [
          { $gt: ['$views', 0] },
          { $multiply: [{ $divide: ['$totalVotes', '$views'] }, 100] },
          0
        ]
      }
    }},
    { $sort: { totalVotes: -1 } },
    { $limit: 10 }
  ]);

  // Get image statistics
  const imageStats = await VotingCampaign.aggregate([
    { $match: { clientId: req.clientId, isDeleted: false } },
    { $unwind: '$items' },
    { $project: {
      itemId: '$items.itemId',
      imageCount: { $size: { $ifNull: ['$items.images', []] } }
    }},
    { $group: {
      _id: null,
      totalItems: { $sum: 1 },
      itemsWithImages: { 
        $sum: { $cond: [{ $gt: ['$imageCount', 0] }, 1, 0] }
      },
      totalImages: { $sum: '$imageCount' }
    }}
  ]);

  res.json({
    success: true,
    data: {
      summary: stats,
      recentActivity: voteActivity,
      topCampaigns,
      imageStats: imageStats[0] || { totalItems: 0, itemsWithImages: 0, totalImages: 0 }
    }
  });
}));

module.exports = router;