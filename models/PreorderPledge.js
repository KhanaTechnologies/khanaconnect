// models/PreorderPledge.js
const mongoose = require('mongoose');

const preorderPledgeSchema = new mongoose.Schema({
  // Basic Information
  preorderId: {
    type: String,
    required: true,
    unique: true,
    default: () => 'PRE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9).toUpperCase()
  },
  
  // Product Information
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Product'
  },
  
  productName: {
    type: String
  },
  
  // Campaign Information
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true
  },
  
  campaignType: {
    type: String,
    enum: ['funding', 'interest'],
    required: true
  },
  
  // OBLIGATION STATUS
  isObligated: {
    type: Boolean,
    required: true,
    default: false,
    description: 'False = non-binding interest, True = binding commitment to purchase'
  },
  
  // For FUNDING campaigns (with pledges)
  pledgeAmount: {
    type: Number,
    min: [0, 'Pledge amount must be at least 0'],
    validate: {
      validator: function(value) {
        // If obligated and campaign is funding, amount must be > 0
        if (this.campaignType === 'funding' && this.isObligated && value <= 0) return false;
        // If not obligated or campaign is interest, amount should be 0
        if ((this.campaignType === 'interest' || !this.isObligated) && value > 0) return false;
        return true;
      },
      message: 'Invalid pledge amount for campaign type and obligation status'
    }
  },
  
  pledgeTier: {
    type: String,
    enum: ['basic', 'early-bird', 'vip', 'enterprise', null],
    default: null
  },
  
  // User/Customer Information
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  customerInfo: {
    name: {
      type: String,
      required: [true, 'Customer name is required'],
      trim: true
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      lowercase: true,
      match: [/^\w+([\.-]?\w+)*@\w+([\.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
    },
    phone: {
      type: String,
      trim: true
    },
    address: {
      street: String,
      city: String,
      state: String,
      zipCode: String,
      country: String
    }
  },
  
  // Communication Preferences
  communicationPreferences: {
    emailUpdates: {
      type: Boolean,
      default: true
    },
    smsUpdates: {
      type: Boolean,
      default: false
    },
    marketingConsent: {
      type: Boolean,
      default: false
    }
  },
  
  // Payment Information (only for obligated funding pledges)
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'failed', 'refunded', 'not_applicable'],
    default: function() {
      if (this.campaignType === 'funding' && this.isObligated) {
        return 'pending';
      }
      return 'not_applicable';
    }
  },
  
  paymentMethod: {
    type: String,
    enum: ['bank_transfer', 'eft', 'cash', 'credit_card', 'paypal', 'crypto', 'not_applicable'],
    default: 'not_applicable'
  },
  
  clientId: {
    type: String,
    required: true,
    index: true
  },

  paymentDetails: {
    transactionId: String,
    paidAt: Date,
    paymentGateway: String,
    lastFourDigits: String
  },
  
  // Status
  status: {
    type: String,
    enum: ['interested', 'committed', 'cancelled', 'converted', 'fulfilled', 'expired'],
    default: function() {
      if (this.campaignType === 'interest') {
        return 'interested';
      }
      return this.isObligated ? 'committed' : 'interested';
    }
  },
  
  // Conversion tracking (for interest -> commitment)
  convertedFrom: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PreorderPledge',
    description: 'If this obligated pledge was converted from an interest signup'
  },
  
  convertedAt: {
    type: Date
  },
  
  // Selected rewards (for funding campaigns)
  selectedRewards: [{
    rewardId: String,
    rewardName: String,
    quantity: {
      type: Number,
      default: 1
    }
  }],
  
  // Timeline
  signupDate: {
    type: Date,
    default: Date.now
  },
  
  commitmentDate: {
    type: Date,
    description: 'When the user committed to an obligated pledge'
  },
  
  estimatedDelivery: {
    type: Date
  },
  
  actualDeliveryDate: Date,
  
  campaignEndDate: Date,
  
  // For interest campaigns - additional fields
  interestLevel: {
    type: String,
    enum: ['low', 'medium', 'high', null],
    default: null,
    description: 'How interested the user is (self-reported)'
  },
  
  expectedQuantity: {
    type: Number,
    min: 1,
    default: 1,
    description: 'How many units they might purchase'
  },
  
  budget: {
    type: String,
    enum: ['under-100', '100-500', '500-1000', 'over-1000', null],
    default: null
  },
  
  // Metadata
  notes: {
    type: String,
    maxlength: 500
  },
  
  tags: [String],
  
  // Source tracking
  source: {
    type: String,
    enum: ['website', 'landing_page', 'email', 'social', 'referral', 'admin', 'qr_code'],
    default: 'website'
  },
  
  referralCode: String,
  
  // Tracking
  lastUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // Soft delete
  isDeleted: {
    type: Boolean,
    default: false
  },
  
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
preorderPledgeSchema.index({ preorderId: 1 });
preorderPledgeSchema.index({ userId: 1, createdAt: -1 });
preorderPledgeSchema.index({ productId: 1, status: 1 });
preorderPledgeSchema.index({ campaignId: 1, status: 1 });
preorderPledgeSchema.index({ campaignId: 1, campaignType: 1 });
preorderPledgeSchema.index({ email: 1 });
preorderPledgeSchema.index({ clientId: 1, campaignType: 1 });
preorderPledgeSchema.index({ 'customerInfo.email': 1, campaignId: 1 }, { unique: true, sparse: true });

// Virtuals
preorderPledgeSchema.virtual('fullName').get(function() {
  return `${this.customerInfo.name}`;
});

preorderPledgeSchema.virtual('isInterestOnly').get(function() {
  return this.campaignType === 'interest' || (!this.isObligated && this.campaignType === 'funding');
});

preorderPledgeSchema.virtual('isCommitment').get(function() {
  return this.campaignType === 'funding' && this.isObligated;
});

preorderPledgeSchema.virtual('responseType').get(function() {
  if (this.campaignType === 'interest') return 'Interest Signup';
  return this.isObligated ? 'Pledge Commitment' : 'Interest (Funding Campaign)';
});

// Methods
preorderPledgeSchema.methods.getDaysUntilDelivery = function() {
  if (!this.estimatedDelivery) return null;
  const today = new Date();
  const diffTime = this.estimatedDelivery - today;
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
};

preorderPledgeSchema.methods.isOverdue = function() {
  if (!this.estimatedDelivery) return false;
  return this.estimatedDelivery < new Date() && ['interested', 'committed'].includes(this.status);
};

// Convert interest to commitment (for funding campaigns)
preorderPledgeSchema.methods.convertToCommitment = async function(pledgeAmount, paymentMethod, tierId = null) {
  if (this.campaignType !== 'funding') {
    throw new Error('Cannot convert interest campaign to commitment');
  }
  
  if (this.isObligated) {
    throw new Error('This preorder is already obligated');
  }
  
  this.isObligated = true;
  this.pledgeAmount = pledgeAmount;
  this.paymentMethod = paymentMethod;
  this.paymentStatus = 'pending';
  this.status = 'committed';
  this.commitmentDate = new Date();
  if (tierId) {
    this.pledgeTier = tierId;
  }
  
  await this.save();
  return this;
};

// Process refund (for obligated funding pledges)
preorderPledgeSchema.methods.processRefund = async function(reason) {
  if (this.campaignType !== 'funding' || !this.isObligated) {
    throw new Error('Can only refund obligated funding pledges');
  }
  
  this.paymentStatus = 'refunded';
  this.status = 'cancelled';
  this.notes = this.notes 
    ? `${this.notes}\nRefunded: ${reason} (${new Date().toISOString()})`
    : `Refunded: ${reason} (${new Date().toISOString()})`;
  await this.save();
};

// Static methods
preorderPledgeSchema.statics.findActiveByUser = function(userId) {
  return this.find({ 
    userId, 
    status: { $in: ['interested', 'committed'] },
    isDeleted: false 
  }).sort({ createdAt: -1 });
};

preorderPledgeSchema.statics.findByCampaignAndEmail = function(campaignId, email) {
  return this.findOne({
    campaignId,
    'customerInfo.email': email,
    isDeleted: false
  });
};

preorderPledgeSchema.statics.getInterestStats = async function(campaignId) {
  const stats = await this.aggregate([
    { $match: { 
      campaignId: new mongoose.Types.ObjectId(campaignId), 
      isDeleted: false 
    }},
    { $group: {
      _id: '$campaignType',
      totalSignups: { $sum: 1 },
      uniqueEmails: { $addToSet: '$customerInfo.email' },
      // For funding campaigns
      totalPledged: { 
        $sum: { 
          $cond: [
            { $and: [
              { $eq: ['$campaignType', 'funding'] },
              { $eq: ['$isObligated', true] }
            ]}, 
            '$pledgeAmount', 
            0
          ]
        }
      },
      // For interest campaigns
      interestLevels: {
        $push: '$interestLevel'
      },
      expectedQuantities: {
        $sum: '$expectedQuantity'
      }
    }},
    { $project: {
      totalSignups: 1,
      uniqueSignups: { $size: '$uniqueEmails' },
      totalPledged: 1,
      averageExpectedQuantity: { $avg: '$expectedQuantity' },
      interestBreakdown: {
        low: { $size: { $filter: { input: '$interestLevels', as: 'level', cond: { $eq: ['$$level', 'low'] } } } },
        medium: { $size: { $filter: { input: '$interestLevels', as: 'level', cond: { $eq: ['$$level', 'medium'] } } } },
        high: { $size: { $filter: { input: '$interestLevels', as: 'level', cond: { $eq: ['$$level', 'high'] } } } }
      }
    }}
  ]);
  
  return stats[0] || { 
    totalSignups: 0, 
    uniqueSignups: 0, 
    totalPledged: 0,
    interestBreakdown: { low: 0, medium: 0, high: 0 }
  };
};

preorderPledgeSchema.statics.getCampaignStats = async function(campaignId) {
  const campaign = await mongoose.model('Campaign').findById(campaignId);
  if (!campaign) return null;

  if (campaign.campaignType === 'interest') {
    return this.getInterestStats(campaignId);
  }

  // Funding campaign stats
  const stats = await this.aggregate([
    { $match: { 
      campaignId: new mongoose.Types.ObjectId(campaignId), 
      isDeleted: false 
    }},
    { $group: {
      _id: '$isObligated',
      count: { $sum: 1 },
      totalAmount: { $sum: '$pledgeAmount' },
      paidAmount: { 
        $sum: { 
          $cond: [
            { $eq: ['$paymentStatus', 'paid'] }, 
            '$pledgeAmount', 
            0
          ]
        }
      },
      emails: { $addToSet: '$customerInfo.email' }
    }}
  ]);

  const paymentBreakdown = await this.aggregate([
    { $match: { 
      campaignId: new mongoose.Types.ObjectId(campaignId), 
      isObligated: true,
      isDeleted: false 
    }},
    { $group: {
      _id: '$paymentStatus',
      count: { $sum: 1 },
      amount: { $sum: '$pledgeAmount' }
    }}
  ]);

  const result = {
    interested: { count: 0, totalAmount: 0 },
    committed: { count: 0, totalAmount: 0, paidAmount: 0, paymentBreakdown },
    uniqueSignups: 0
  };

  stats.forEach(stat => {
    if (stat._id === false) {
      result.interested.count = stat.count;
      result.interested.totalAmount = stat.totalAmount;
    } else {
      result.committed.count = stat.count;
      result.committed.totalAmount = stat.totalAmount;
      result.committed.paidAmount = stat.paidAmount;
    }
    result.uniqueSignups = stat.emails ? stat.emails.length : 0;
  });

  // Get conversion rate
  const totalInterested = result.interested.count;
  const converted = await this.countDocuments({
    campaignId,
    convertedFrom: { $ne: null },
    isDeleted: false
  });

  result.conversionRate = totalInterested > 0 ? (converted / totalInterested) * 100 : 0;

  return result;
};

// Pre-save middleware
preorderPledgeSchema.pre('save', async function(next) {
  // Set estimated delivery based on campaign end date plus processing time
  if (this.campaignEndDate && !this.estimatedDelivery) {
    const deliveryDate = new Date(this.campaignEndDate);
    deliveryDate.setMonth(deliveryDate.getMonth() + 3);
    this.estimatedDelivery = deliveryDate;
  }
  
  // Update campaign counts
  const Campaign = mongoose.model('Campaign');
  const campaign = await Campaign.findById(this.campaignId);
  
  if (campaign && this.isNew) {
    if (campaign.campaignType === 'interest') {
      // For interest campaigns, just increment interested count
      await Campaign.findByIdAndUpdate(this.campaignId, {
        $inc: { interestedCount: 1 }
      });
      
      // Check for unique email
      const existingWithEmail = await mongoose.model('PreorderPledge').findOne({
        campaignId: this.campaignId,
        'customerInfo.email': this.customerInfo.email,
        _id: { $ne: this._id },
        isDeleted: false
      });
      
      if (!existingWithEmail) {
        await Campaign.findByIdAndUpdate(this.campaignId, {
          $inc: { uniqueSignupsCount: 1 }
        });
      }
    } else {
      // For funding campaigns
      if (this.isObligated) {
        await Campaign.findByIdAndUpdate(this.campaignId, {
          $inc: { backersCount: 1, amountRaised: this.pledgeAmount }
        });
      } else {
        await Campaign.findByIdAndUpdate(this.campaignId, {
          $inc: { interestedCount: 1 }
        });
      }
    }
  }
  
  next();
});

// Pre-update middleware
preorderPledgeSchema.pre('findOneAndUpdate', function() {
  this.set({ updatedAt: new Date() });
});

module.exports = mongoose.model('PreorderPledge', preorderPledgeSchema);