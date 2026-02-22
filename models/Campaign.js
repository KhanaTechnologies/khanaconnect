// models/Campaign.js
const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  // Basic Information
  campaignId: {
    type: String,
    required: true,
    unique: true,
    default: () => 'CAMP-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase()
  },
  
  // Client Association
  clientId: {
    type: String,
    required: [true, 'Client ID is required'],
    index: true
  },
  
  // CAMPAIGN TYPE - NEW
  campaignType: {
    type: String,
    enum: ['funding', 'interest'],
    required: [true, 'Campaign type is required'],
    default: 'funding',
    description: 'funding = collect money pledges, interest = just gauge interest/sign-ups'
  },
  
  // Campaign Details
  name: {
    type: String,
    required: [true, 'Campaign name is required'],
    trim: true,
    maxlength: 100
  },
  
  description: {
    type: String,
    required: [true, 'Campaign description is required'],
    maxlength: 2000
  },
  
  shortDescription: {
    type: String,
    maxlength: 200
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
  status: {
    type: String,
    enum: ['draft', 'active', 'paused', 'ended', 'cancelled'],
    default: 'draft'
  },
  
  // Funding Goals - CONDITIONAL based on campaignType
  fundingGoal: {
    type: Number,
    required: function() {
      return this.campaignType === 'funding';
    },
    min: [1, 'Funding goal must be at least 1']
  },
  
  minimumPledge: {
    type: Number,
    default: function() {
      return this.campaignType === 'funding' ? 1 : null;
    },
    min: [1, 'Minimum pledge must be at least 1']
  },
  
  maximumPledge: {
    type: Number,
    min: [1, 'Maximum pledge must be at least 1']
  },
  
  // Product Information
  products: [{
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    },
    productName: String,
    quantity: Number,
    price: Number
  }],
  
  // Rewards Tiers - only for funding campaigns
  rewardTiers: {
    type: [{
      tierId: {
        type: String,
        default: () => 'TIER-' + Math.random().toString(36).substr(2, 8).toUpperCase()
      },
      name: {
        type: String,
        required: true
      },
      description: String,
      pledgeAmount: {
        type: Number,
        required: true,
        min: [1, 'Pledge amount must be at least 1']
      },
      rewards: [{
        rewardId: String,
        rewardName: String,
        description: String,
        estimatedDelivery: Date
      }],
      quantity: {
        type: Number,
        default: null // null means unlimited
      },
      quantityClaimed: {
        type: Number,
        default: 0
      },
      isLimited: {
        type: Boolean,
        default: false
      },
      isActive: {
        type: Boolean,
        default: true
      }
    }],
    validate: {
      validator: function(v) {
        // Funding campaigns can have reward tiers, interest campaigns cannot
        if (this.campaignType === 'interest' && v && v.length > 0) {
          return false;
        }
        return true;
      },
      message: 'Interest campaigns cannot have reward tiers'
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
  
  // Campaign Creator
  createdBy: {
    type: String,
    required: true
  },
  
  // Campaign Settings
  settings: {
    allowMultiplePledges: {
      type: Boolean,
      default: false
    },
    requireShipping: {
      type: Boolean,
      default: true
    },
    internationalShipping: {
      type: Boolean,
      default: false
    },
    shippingCountries: [String],
    autoClose: {
      type: Boolean,
      default: true
    },
    paymentMethods: [{
      type: String,
      enum: ['credit_card', 'paypal', 'bank_transfer', 'crypto']
    }],
    currency: {
      type: String,
      default: 'USD'
    },
    // Interest campaign specific settings
    collectPhoneNumber: {
      type: Boolean,
      default: false
    },
    collectAddress: {
      type: Boolean,
      default: false
    },
    allowMultipleSignups: {
      type: Boolean,
      default: true
    }
  },
  
  // Updates (for campaign progress)
  updates: [{
    updateId: {
      type: String,
      default: () => 'UPD-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6)
    },
    title: String,
    content: String,
    publishedAt: {
      type: Date,
      default: Date.now
    },
    publishedBy: String,
    isPublic: {
      type: Boolean,
      default: true
    }
  }],
  
  // FAQs
  faqs: [{
    question: String,
    answer: String,
    order: Number
  }],
  
  // Tags/Categories
  categories: [String],
  tags: [String],
  
  // Tracking - different metrics based on campaign type
  views: {
    type: Number,
    default: 0
  },
  
  // For funding campaigns
  backersCount: {
    type: Number,
    default: 0
  },
  
  amountRaised: {
    type: Number,
    default: 0
  },
  
  // For interest campaigns
  interestedCount: {
    type: Number,
    default: 0
  },
  
  // For both - unique signups (deduplicated by email)
  uniqueSignupsCount: {
    type: Number,
    default: 0
  },
  
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

// Indexes for better performance
campaignSchema.index({ clientId: 1, status: 1 });
campaignSchema.index({ clientId: 1, campaignType: 1 });
campaignSchema.index({ clientId: 1, startDate: 1, endDate: 1 });
campaignSchema.index({ campaignId: 1 });
campaignSchema.index({ status: 1, endDate: 1 });
campaignSchema.index({ categories: 1 });

// Virtual for days remaining
campaignSchema.virtual('daysRemaining').get(function() {
  if (this.status !== 'active' || !this.endDate) return 0;
  const now = new Date();
  const end = new Date(this.endDate);
  const diffTime = end - now;
  return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
});

// Virtual for progress percentage - only for funding campaigns
campaignSchema.virtual('progressPercentage').get(function() {
  if (this.campaignType !== 'funding' || !this.fundingGoal) return null;
  return Math.min(100, Math.round((this.amountRaised / this.fundingGoal) * 100));
});

// Virtual for isExpired
campaignSchema.virtual('isExpired').get(function() {
  return this.endDate && new Date(this.endDate) < new Date();
});

// Virtual for total responses (for interest campaigns)
campaignSchema.virtual('totalResponses').get(function() {
  if (this.campaignType === 'interest') {
    return this.interestedCount;
  }
  return this.backersCount;
});

// Virtual for campaign type display
campaignSchema.virtual('typeDisplay').get(function() {
  return this.campaignType === 'funding' ? 'Funding Campaign' : 'Interest Campaign';
});

// Method to check if campaign is active
campaignSchema.methods.isActive = function() {
  const now = new Date();
  return this.status === 'active' && 
         this.startDate <= now && 
         this.endDate >= now && 
         !this.isDeleted;
};

// Method to update raised amount (funding campaigns only)
campaignSchema.methods.updateRaisedAmount = async function(amount, isAddition = true) {
  if (this.campaignType !== 'funding') {
    throw new Error('Cannot update raised amount for interest campaigns');
  }
  if (isAddition) {
    this.amountRaised += amount;
    this.backersCount += 1;
  } else {
    this.amountRaised -= amount;
    this.backersCount -= 1;
  }
  await this.save();
};

// Method to update interested count (interest campaigns only)
campaignSchema.methods.updateInterestedCount = async function(isAddition = true, isUnique = true) {
  if (this.campaignType !== 'interest') {
    throw new Error('Cannot update interested count for funding campaigns');
  }
  if (isAddition) {
    this.interestedCount += 1;
    if (isUnique) {
      this.uniqueSignupsCount += 1;
    }
  } else {
    this.interestedCount -= 1;
    if (isUnique) {
      this.uniqueSignupsCount -= 1;
    }
  }
  await this.save();
};

// Method to add an update
campaignSchema.methods.addUpdate = async function(title, content, publishedBy, isPublic = true) {
  this.updates.push({
    title,
    content,
    publishedBy,
    isPublic
  });
  await this.save();
  return this.updates[this.updates.length - 1];
};

// Static method to find active campaigns by client
campaignSchema.statics.findActiveByClient = function(clientId, type = null) {
  const now = new Date();
  const filter = {
    clientId,
    status: 'active',
    startDate: { $lte: now },
    endDate: { $gte: now },
    isDeleted: false
  };
  if (type) {
    filter.campaignType = type;
  }
  return this.find(filter).sort({ endDate: 1 });
};

// Static method to get campaign statistics
campaignSchema.statics.getClientStats = async function(clientId) {
  const stats = await this.aggregate([
    { $match: { clientId, isDeleted: false } },
    { $group: {
      _id: { status: '$status', type: '$campaignType' },
      count: { $sum: 1 },
      totalGoal: { $sum: '$fundingGoal' },
      totalRaised: { $sum: '$amountRaised' },
      totalBackers: { $sum: '$backersCount' },
      totalInterested: { $sum: '$interestedCount' },
      totalUnique: { $sum: '$uniqueSignupsCount' }
    }},
    { $sort: { '_id.status': 1 } }
  ]);
  
  // Also get totals by type
  const byType = await this.aggregate([
    { $match: { clientId, isDeleted: false } },
    { $group: {
      _id: '$campaignType',
      count: { $sum: 1 },
      totalResponses: { 
        $sum: { 
          $cond: [
            { $eq: ['$campaignType', 'funding'] },
            '$backersCount',
            '$interestedCount'
          ]
        }
      },
      totalAmount: { $sum: '$amountRaised' }
    }}
  ]);
  
  return {
    byStatus: stats,
    byType
  };
};

// Static method to check if email already signed up for interest campaign
campaignSchema.statics.hasEmailSignedUp = async function(campaignId, email) {
  const PreorderPledge = mongoose.model('PreorderPledge');
  const existing = await PreorderPledge.findOne({
    campaignId,
    'customerInfo.email': email,
    isDeleted: false,
    status: 'interested'
  });
  return !!existing;
};

// Pre-save middleware
campaignSchema.pre('save', function(next) {
  // Validate dates
  if (this.startDate && this.endDate && this.startDate >= this.endDate) {
    next(new Error('End date must be after start date'));
  }
  
  // Validate funding goal for funding campaigns
  if (this.campaignType === 'funding' && !this.fundingGoal) {
    next(new Error('Funding goal is required for funding campaigns'));
  }
  
  // Auto-update status based on dates
  const now = new Date();
  if (this.status === 'active') {
    if (this.endDate < now) {
      this.status = 'ended';
    } else if (this.startDate > now) {
      this.status = 'draft';
    }
  }
  
  next();
});

// Pre-update middleware
campaignSchema.pre('findOneAndUpdate', function() {
  this.set({ updatedAt: new Date() });
});

module.exports = mongoose.model('Campaign', campaignSchema);