// models/VotingCampaign.js
const mongoose = require('mongoose');

const votingCampaignSchema = new mongoose.Schema({
  // Basic Information
  campaignId: {
    type: String,
    required: true,
    unique: true,
    default: () => 'VOTE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase()
  },
  
  // Client Association
  clientId: {
    type: String,
    required: [true, 'Client ID is required'],
    index: true
  },
  
  // Campaign Type
  campaignType: {
    type: String,
    enum: ['campaign', 'poll'],
    required: true,
    description: 'campaign = longer running with goals, poll = quick voting'
  },
  
  // Campaign Details
  title: {
    type: String,
    required: [true, 'Campaign title is required'],
    trim: true,
    maxlength: 200
  },
  
  description: {
    type: String,
    required: [true, 'Description is required'],
    maxlength: 2000
  },
  
  shortDescription: {
    type: String,
    maxlength: 300
  },
  
  // Voting Items (2 or more) - ENHANCED IMAGE SUPPORT
  items: {
    type: [{
      itemId: {
        type: String,
        default: () => 'ITEM-' + Math.random().toString(36).substr(2, 8).toUpperCase()
      },
      title: {
        type: String,
        required: [true, 'Item title is required'],
        maxlength: 100
      },
      description: {
        type: String,
        maxlength: 500
      },
      // IMAGES ARRAY - for multiple images per item
      images: [{
        url: {
          type: String,
          required: true
        },
        thumbnail: String,
        medium: String,
        publicId: String,
        caption: String,
        isPrimary: {
          type: Boolean,
          default: false
        },
        order: {
          type: Number,
          default: 0
        },
        dimensions: {
          width: Number,
          height: Number
        },
        fileSize: Number,
        format: String,
        uploadedAt: {
          type: Date,
          default: Date.now
        }
      }],
      // Main display image (for quick access)
      mainImage: {
        type: String,
        default: null
      },
      thumbnail: {
        type: String,
        default: null
      },
      // For campaign type (if there's a goal)
      goal: {
        type: Number,
        min: 1
      },
      // Tracking
      votesCount: {
        type: Number,
        default: 0
      },
      // Visual options - can have both icons AND images
      icon: {
        type: String,
        default: null,
        description: 'Optional emoji or icon for fallback'
      },
      // Metadata
      metadata: {
        type: Map,
        of: mongoose.Schema.Types.Mixed
      },
      itemActive: {
        type: Boolean,
        default: true
      },
      // Image display settings
      displaySettings: {
        imageFit: {
          type: String,
          enum: ['cover', 'contain', 'fill'],
          default: 'cover'
        },
        showCaption: {
          type: Boolean,
          default: false
        },
        imageAspectRatio: {
          type: String,
          enum: ['1:1', '16:9', '4:3', '3:2'],
          default: '1:1'
        }
      }
    }],
    validate: {
      validator: function(items) {
        return items && items.length >= 2;
      },
      message: 'At least 2 voting items are required'
    }
  },
  
  // Campaign Timeline
  startDate: {
    type: Date,
    required: [true, 'Start date is required']
  },
  
  endDate: {
    type: Date,
    required: [true, 'End date is required']
  },
  
  // Campaign Status
  campaignStatus: {
    type: String,
    enum: ['draft', 'active', 'paused', 'ended', 'cancelled'],
    default: 'draft'
  },
  
  // Voting Rules
  votingRules: {
    allowMultipleVotes: {
      type: Boolean,
      default: false
    },
    maxVotesPerCustomer: {
      type: Number,
      default: 1,
      min: 1
    },
    requireVerification: {
      type: Boolean,
      default: true
    },
    allowAnonymous: {
      type: Boolean,
      default: false
    },
    voteChangeAllowed: {
      type: Boolean,
      default: false
    },
    resultsVisibility: {
      type: String,
      enum: ['public', 'voters_only', 'admin_only'],
      default: 'public'
    }
  },
  
  // Campaign Media
  media: {
    coverImage: {
      type: String,
      default: null
    },
    coverImagePublicId: {
      type: String,
      default: null
    },
    gallery: [{
      url: String,
      publicId: String,
      caption: String
    }],
    video: {
      url: String,
      publicId: String
    }
  },
  
  // Creator
  createdBy: {
    type: String,
    required: true
  },
  
  // Settings
  settings: {
    requireLogin: {
      type: Boolean,
      default: true
    },
    showProgressBar: {
      type: Boolean,
      default: true
    },
    showLeaderboard: {
      type: Boolean,
      default: true
    },
    allowComments: {
      type: Boolean,
      default: false
    },
    notifyOnVote: {
      type: Boolean,
      default: false
    },
    currency: {
      type: String,
      default: 'USD'
    },
    // Visual settings for the campaign
    visualSettings: {
      primaryColor: {
        type: String,
        default: '#3B82F6'
      },
      cardLayout: {
        type: String,
        enum: ['grid', 'list', 'carousel'],
        default: 'grid'
      },
      columnsPerRow: {
        type: Number,
        enum: [2, 3, 4],
        default: 3
      },
      showItemImages: {
        type: Boolean,
        default: true
      },
      imageHoverEffect: {
        type: Boolean,
        default: true
      },
      // NEW: Default image to show if item has no images
      defaultItemImage: {
        type: String,
        default: '/uploads/voting/default-item.jpg'
      }
    }
  },
  
  // Tracking
  views: {
    type: Number,
    default: 0
  },
  
  totalVotes: {
    type: Number,
    default: 0
  },
  
  uniqueVoters: {
    type: Number,
    default: 0
  },
  
  // Categories and Tags
  categories: [String],
  tags: [String],
  
  // Metadata
  notes: {
    type: String,
    maxlength: 1000
  },
  
  // Soft delete
  isDeleted: {
    type: Boolean,
    default: false
  },
  
  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
votingCampaignSchema.index({ clientId: 1, campaignStatus: 1 });
votingCampaignSchema.index({ clientId: 1, campaignType: 1 });
votingCampaignSchema.index({ clientId: 1, startDate: 1, endDate: 1 });
votingCampaignSchema.index({ campaignId: 1 });
votingCampaignSchema.index({ campaignStatus: 1, endDate: 1 });
votingCampaignSchema.index({ 'items.itemId': 1 });
votingCampaignSchema.index({ 'items.images.url': 1 });

// Virtuals
votingCampaignSchema.virtual('daysRemaining').get(function() {
  if (this.campaignStatus !== 'active' || !this.endDate) return 0;
  const now = new Date();
  const end = new Date(this.endDate);
  const diffTime = end - now;
  return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
});

votingCampaignSchema.virtual('hoursRemaining').get(function() {
  if (this.campaignStatus !== 'active' || !this.endDate) return 0;
  const now = new Date();
  const end = new Date(this.endDate);
  const diffTime = end - now;
  return Math.max(0, Math.floor(diffTime / (1000 * 60 * 60)));
});

votingCampaignSchema.virtual('isExpired').get(function() {
  return this.endDate && new Date(this.endDate) < new Date();
});

votingCampaignSchema.virtual('campaignActive').get(function() {
  const now = new Date();
  return this.campaignStatus === 'active' && 
         this.startDate <= now && 
         this.endDate >= now && 
         !this.isDeleted;
});

// Virtual that returns items with their images properly formatted
votingCampaignSchema.virtual('itemsWithImages').get(function() {
  return this.items.map(item => {
    // Get primary image or first image
    const primaryImage = item.images && item.images.length > 0 
      ? (item.images.find(img => img.isPrimary) || item.images[0])
      : null;
    
    return {
      itemId: item.itemId || item._id,
      title: item.title,
      description: item.description,
      // Full images array for gallery view
      images: item.images || [],
      // Convenience fields for display
      displayImage: primaryImage ? (primaryImage.medium || primaryImage.url) : (this.settings.visualSettings.defaultItemImage || null),
      thumbnail: primaryImage ? primaryImage.thumbnail : null,
      // Fallback to icon if no images
      icon: item.icon,
      hasImages: item.images && item.images.length > 0,
      votesCount: item.votesCount,
      goal: item.goal,
      displaySettings: item.displaySettings,
      itemActive: item.itemActive
    };
  });
});

votingCampaignSchema.virtual('itemsWithStats').get(function() {
  return this.items.map(item => {
    const percentage = this.totalVotes > 0 
      ? Math.round((item.votesCount / this.totalVotes) * 100) 
      : 0;
    
    const primaryImage = item.images && item.images.length > 0 
      ? (item.images.find(img => img.isPrimary) || item.images[0])
      : null;
    
    return {
      ...item.toObject(),
      percentage,
      goalProgress: item.goal ? Math.min(100, Math.round((item.votesCount / item.goal) * 100)) : null,
      displayImage: primaryImage ? (primaryImage.medium || primaryImage.url) : (this.settings.visualSettings.defaultItemImage || null),
      thumbnail: primaryImage ? primaryImage.thumbnail : null,
      imageCount: item.images ? item.images.length : 0,
      hasImages: item.images && item.images.length > 0,
      isActive: item.itemActive
    };
  });
});

votingCampaignSchema.virtual('itemsByPopularity').get(function() {
  return [...this.items].sort((a, b) => b.votesCount - a.votesCount);
});

// Methods
votingCampaignSchema.methods.checkIsActive = function() {
  const now = new Date();
  return this.campaignStatus === 'active' && 
         this.startDate <= now && 
         this.endDate >= now && 
         !this.isDeleted;
};

votingCampaignSchema.methods.incrementView = async function() {
  this.views += 1;
  await this.save();
  return this.views;
};

votingCampaignSchema.methods.addVote = async function(itemId) {
  const item = this.items.find(i => i.itemId === itemId || i._id.toString() === itemId);
  if (!item) {
    throw new Error('Voting item not found');
  }
  
  item.votesCount += 1;
  this.totalVotes += 1;
  await this.save();
  
  return {
    itemId: item.itemId || item._id,
    newCount: item.votesCount,
    totalVotes: this.totalVotes
  };
};

votingCampaignSchema.methods.removeVote = async function(itemId) {
  const item = this.items.find(i => i.itemId === itemId || i._id.toString() === itemId);
  if (!item) {
    throw new Error('Voting item not found');
  }
  
  if (item.votesCount > 0) {
    item.votesCount -= 1;
    this.totalVotes -= 1;
    await this.save();
  }
  
  return {
    itemId: item.itemId || item._id,
    newCount: item.votesCount,
    totalVotes: this.totalVotes
  };
};

votingCampaignSchema.methods.getWinningItem = function() {
  if (this.items.length === 0) return null;
  
  return this.items.reduce((max, item) => 
    item.votesCount > max.votesCount ? item : max
  , this.items[0]);
};

votingCampaignSchema.methods.getResults = function() {
  const sorted = [...this.items].sort((a, b) => b.votesCount - a.votesCount);
  
  return {
    totalVotes: this.totalVotes,
    uniqueVoters: this.uniqueVoters,
    items: sorted.map((item, index) => {
      const primaryImage = item.images && item.images.length > 0 
        ? (item.images.find(img => img.isPrimary) || item.images[0])
        : null;
      
      return {
        ...item.toObject(),
        rank: index + 1,
        percentage: this.totalVotes > 0 ? Math.round((item.votesCount / this.totalVotes) * 100) : 0,
        isWinning: index === 0,
        displayImage: primaryImage ? (primaryImage.medium || primaryImage.url) : (this.settings.visualSettings.defaultItemImage || null),
        thumbnail: primaryImage ? primaryImage.thumbnail : null,
        hasImages: item.images && item.images.length > 0,
        isActive: item.itemActive
      };
    })
  };
};

votingCampaignSchema.methods.getItemWithImages = function(itemId) {
  const item = this.items.find(i => i.itemId === itemId || i._id.toString() === itemId);
  if (!item) return null;
  
  const primaryImage = item.images && item.images.length > 0 
    ? (item.images.find(img => img.isPrimary) || item.images[0])
    : null;
  
  return {
    ...item.toObject(),
    images: item.images || [],
    primaryImage: primaryImage,
    displayImage: primaryImage ? (primaryImage.medium || primaryImage.url) : (this.settings.visualSettings.defaultItemImage || null),
    thumbnail: primaryImage ? primaryImage.thumbnail : null,
    hasImages: item.images && item.images.length > 0,
    isActive: item.itemActive
  };
};

// IMAGE MANAGEMENT METHODS
votingCampaignSchema.methods.addItemImage = async function(itemId, imageData) {
  const item = this.items.find(i => i.itemId === itemId || i._id.toString() === itemId);
  if (!item) {
    throw new Error('Item not found');
  }
  
  if (!item.images) {
    item.images = [];
  }
  
  // If this is the first image, set as primary and update mainImage/thumbnail
  if (item.images.length === 0) {
    imageData.isPrimary = true;
    item.mainImage = imageData.medium || imageData.url;
    item.thumbnail = imageData.thumbnail;
  }
  
  imageData.uploadedAt = new Date();
  imageData.order = item.images.length;
  
  item.images.push(imageData);
  
  await this.save();
  return imageData;
};

votingCampaignSchema.methods.removeItemImage = async function(itemId, imageUrl) {
  const item = this.items.find(i => i.itemId === itemId || i._id.toString() === itemId);
  if (!item) {
    throw new Error('Item not found');
  }
  
  if (!item.images) return;
  
  const imageIndex = item.images.findIndex(img => img.url === imageUrl);
  if (imageIndex === -1) return;
  
  const wasPrimary = item.images[imageIndex].isPrimary;
  item.images.splice(imageIndex, 1);
  
  // If we removed the primary image and there are other images, set first as primary
  if (wasPrimary && item.images.length > 0) {
    item.images[0].isPrimary = true;
    item.mainImage = item.images[0].medium || item.images[0].url;
    item.thumbnail = item.images[0].thumbnail;
  } else if (item.images.length === 0) {
    // No images left, clear mainImage and thumbnail
    item.mainImage = null;
    item.thumbnail = null;
  }
  
  await this.save();
};

votingCampaignSchema.methods.setPrimaryImage = async function(itemId, imageUrl) {
  const item = this.items.find(i => i.itemId === itemId || i._id.toString() === itemId);
  if (!item) {
    throw new Error('Item not found');
  }
  
  if (!item.images) return;
  
  // Remove primary flag from all images
  item.images.forEach(img => { img.isPrimary = false; });
  
  // Set new primary image
  const image = item.images.find(img => img.url === imageUrl);
  if (image) {
    image.isPrimary = true;
    item.mainImage = image.medium || image.url;
    item.thumbnail = image.thumbnail;
  }
  
  await this.save();
};

votingCampaignSchema.methods.reorderImages = async function(itemId, imageUrls) {
  const item = this.items.find(i => i.itemId === itemId || i._id.toString() === itemId);
  if (!item) {
    throw new Error('Item not found');
  }
  
  if (!item.images) return;
  
  // Create a map of existing images
  const imageMap = new Map(item.images.map(img => [img.url, img]));
  
  // Reorder based on provided URLs
  item.images = imageUrls
    .filter(url => imageMap.has(url))
    .map((url, index) => {
      const img = imageMap.get(url);
      img.order = index;
      return img;
    });
  
  await this.save();
};

// Static methods
votingCampaignSchema.statics.findActiveByClient = function(clientId, type = null) {
  const now = new Date();
  const filter = {
    clientId,
    campaignStatus: 'active',
    startDate: { $lte: now },
    endDate: { $gte: now },
    isDeleted: false
  };
  
  if (type) {
    filter.campaignType = type;
  }
  
  return this.find(filter).sort({ endDate: 1 });
};

votingCampaignSchema.statics.getClientStats = async function(clientId) {
  const stats = await this.aggregate([
    { $match: { clientId, isDeleted: false } },
    { $group: {
      _id: { status: '$campaignStatus', type: '$campaignType' },
      count: { $sum: 1 },
      totalVotes: { $sum: '$totalVotes' },
      totalViews: { $sum: '$views' },
      avgVotes: { $avg: '$totalVotes' }
    }},
    { $sort: { '_id.status': 1 } }
  ]);
  
  const byType = await this.aggregate([
    { $match: { clientId, isDeleted: false } },
    { $group: {
      _id: '$campaignType',
      count: { $sum: 1 },
      active: {
        $sum: {
          $cond: [
            { $and: [
              { $eq: ['$campaignStatus', 'active'] },
              { $gte: ['$endDate', new Date()] }
            ]},
            1,
            0
          ]
        }
      },
      totalVotes: { $sum: '$totalVotes' },
      totalViews: { $sum: '$views' }
    }}
  ]);
  
  return {
    byStatus: stats,
    byType
  };
};

votingCampaignSchema.statics.checkCustomerVote = async function(campaignId, customerId) {
  const Vote = mongoose.model('Vote');
  const vote = await Vote.findOne({
    campaignId,
    customerId,
    isDeleted: false,
    status: 'active'
  });
  
  return {
    hasVoted: !!vote,
    vote: vote ? {
      voteId: vote.voteId,
      itemId: vote.itemId,
      itemTitle: vote.itemTitle,
      itemImage: vote.itemImageAtVote,
      votedAt: vote.votedAt,
      canChange: vote.canChange
    } : null
  };
};

votingCampaignSchema.statics.getCustomerVoteHistory = async function(customerId) {
  const Vote = mongoose.model('Vote');
  return Vote.find({ customerId, isDeleted: false })
    .populate('campaignId', 'title campaignType')
    .sort({ votedAt: -1 });
};

// Pre-save middleware
votingCampaignSchema.pre('save', function(next) {
  if (this.startDate && this.endDate && this.startDate >= this.endDate) {
    next(new Error('End date must be after start date'));
  }
  
  if (!this.items || this.items.length < 2) {
    next(new Error('At least 2 voting items are required'));
  }
  
  const now = new Date();
  if (this.campaignStatus === 'active') {
    if (this.endDate < now) {
      this.campaignStatus = 'ended';
    } else if (this.startDate > now) {
      this.campaignStatus = 'draft';
    }
  }
  
  next();
});

// Pre-update middleware
votingCampaignSchema.pre('findOneAndUpdate', function() {
  this.set({ updatedAt: new Date() });
});

module.exports = mongoose.model('VotingCampaign', votingCampaignSchema);