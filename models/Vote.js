// models/Vote.js
const mongoose = require('mongoose');

const voteSchema = new mongoose.Schema({
  // Basic Information
  voteId: {
    type: String,
    required: true,
    unique: true,
    default: () => 'VOTE-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9).toUpperCase()
  },
  
  // Campaign Reference
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'VotingCampaign',
    required: [true, 'Campaign ID is required'],
    index: true
  },
  
  // Item Voted For
  itemId: {
    type: String,
    required: [true, 'Item ID is required'],
    index: true
  },
  
  itemTitle: {
    type: String,
    required: [true, 'Item title is required']
  },
  
  // Store the item image at time of voting (for historical accuracy)
  itemImageAtVote: {
    type: String,
    default: null
  },
  
  // Customer Information
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: [true, 'Customer ID is required'],
    index: true
  },
  
  customerInfo: {
    name: {
      type: String,
      required: [true, 'Customer name is required']
    },
    email: {
      type: String,
      required: [true, 'Customer email is required'],
      lowercase: true
    }
  },
  
  // Client Association
  clientId: {
    type: String,
    required: [true, 'Client ID is required'],
    index: true
  },
  
  // Vote Details
  voteWeight: {
    type: Number,
    default: 1,
    min: 1,
    description: 'For weighted voting systems'
  },
  
  voteNumber: {
    type: Number,
    default: 1,
    description: 'Vote number if multiple votes allowed'
  },
  
  // Vote Metadata
  ipAddress: {
    type: String
  },
  
  userAgent: {
    type: String
  },
  
  location: {
    country: String,
    city: String,
    coordinates: {
      lat: Number,
      lng: Number
    }
  },
  
  // Vote Status
  status: {
    type: String,
    enum: ['active', 'changed', 'cancelled'],
    default: 'active'
  },
  
  // For vote changing
  previousVotes: [{
    itemId: String,
    itemTitle: String,
    itemImage: String,
    changedAt: Date,
    voteNumber: Number
  }],
  
  canChange: {
    type: Boolean,
    default: false
  },
  
  // Tracking
  votedAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  
  // Metadata
  notes: {
    type: String,
    maxlength: 500
  },
  
  tags: [String],
  
  source: {
    type: String,
    enum: ['web', 'mobile', 'api', 'qr_code', 'embed'],
    default: 'web'
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

// Compound indexes for unique voting rules
voteSchema.index({ campaignId: 1, customerId: 1 }, { unique: true, sparse: true });
voteSchema.index({ campaignId: 1, customerId: 1, voteNumber: 1 });
voteSchema.index({ campaignId: 1, itemId: 1 });
voteSchema.index({ clientId: 1, votedAt: -1 });

// Virtuals
voteSchema.virtual('voteAge').get(function() {
  const now = new Date();
  const diffTime = now - this.votedAt;
  return Math.floor(diffTime / (1000 * 60 * 60 * 24)); // days
});

voteSchema.virtual('voteAgeHours').get(function() {
  const now = new Date();
  const diffTime = now - this.votedAt;
  return Math.floor(diffTime / (1000 * 60 * 60)); // hours
});

// Methods
voteSchema.methods.changeVote = async function(newItemId, newItemTitle, newItemImage = null) {
  // Record previous vote
  this.previousVotes.push({
    itemId: this.itemId,
    itemTitle: this.itemTitle,
    itemImage: this.itemImageAtVote,
    changedAt: new Date(),
    voteNumber: this.voteNumber
  });
  
  // Update to new item
  this.itemId = newItemId;
  this.itemTitle = newItemTitle;
  this.itemImageAtVote = newItemImage;
  this.status = 'changed';
  this.lastUpdated = new Date();
  
  await this.save();
  
  // Update campaign vote counts
  const VotingCampaign = mongoose.model('VotingCampaign');
  const campaign = await VotingCampaign.findById(this.campaignId);
  
  if (campaign) {
    // Remove vote from old item
    await campaign.removeVote(this.previousVotes[this.previousVotes.length - 1].itemId);
    // Add vote to new item
    await campaign.addVote(newItemId);
  }
  
  return this;
};

voteSchema.methods.cancel = async function(reason) {
  this.status = 'cancelled';
  this.notes = this.notes 
    ? `${this.notes}\nCancelled: ${reason || 'No reason'} (${new Date().toISOString()})`
    : `Cancelled: ${reason || 'No reason'} (${new Date().toISOString()})`;
  
  await this.save();
  
  // Update campaign vote counts
  const VotingCampaign = mongoose.model('VotingCampaign');
  const campaign = await VotingCampaign.findById(this.campaignId);
  
  if (campaign) {
    await campaign.removeVote(this.itemId);
  }
  
  return this;
};

// Static methods
voteSchema.statics.getCampaignStats = async function(campaignId) {
  const stats = await this.aggregate([
    { $match: { campaignId: new mongoose.Types.ObjectId(campaignId), isDeleted: false, status: 'active' } },
    { $group: {
      _id: '$itemId',
      count: { $sum: 1 },
      totalWeight: { $sum: '$voteWeight' },
      uniqueVoters: { $addToSet: '$customerId' }
    }},
    { $project: {
      itemId: '$_id',
      count: 1,
      totalWeight: 1,
      uniqueVoters: { $size: '$uniqueVoters' }
    }}
  ]);
  
  // Get vote timeline
  const timeline = await this.aggregate([
    { $match: { campaignId: new mongoose.Types.ObjectId(campaignId), isDeleted: false, status: 'active' } },
    { $group: {
      _id: {
        date: { $dateToString: { format: '%Y-%m-%d', date: '$votedAt' } },
        itemId: '$itemId'
      },
      count: { $sum: 1 }
    }},
    { $sort: { '_id.date': 1 } }
  ]);
  
  // Get voter demographics (if location data exists)
  const demographics = await this.aggregate([
    { $match: { 
      campaignId: new mongoose.Types.ObjectId(campaignId), 
      isDeleted: false,
      status: 'active',
      'location.country': { $exists: true, $ne: null }
    }},
    { $group: {
      _id: '$location.country',
      count: { $sum: 1 }
    }},
    { $sort: { count: -1 } }
  ]);
  
  return {
    itemStats: stats,
    timeline,
    demographics
  };
};

voteSchema.statics.getCustomerVotes = async function(customerId) {
  return this.find({ customerId, isDeleted: false, status: 'active' })
    .populate('campaignId', 'title campaignType endDate media.coverImage')
    .sort({ votedAt: -1 });
};

voteSchema.statics.hasVoted = async function(campaignId, customerId) {
  const count = await this.countDocuments({
    campaignId,
    customerId,
    isDeleted: false,
    status: 'active'
  });
  return count > 0;
};

voteSchema.statics.getVoteCount = async function(campaignId, customerId) {
  return this.countDocuments({
    campaignId,
    customerId,
    isDeleted: false,
    status: 'active'
  });
};

// Pre-save middleware
voteSchema.pre('save', async function(next) {
  if (this.isNew) {
    // Get campaign to check voting rules
    const VotingCampaign = mongoose.model('VotingCampaign');
    const campaign = await VotingCampaign.findById(this.campaignId);
    
    if (campaign) {
      // Check if customer has already voted
      const existingVote = await mongoose.model('Vote').findOne({
        campaignId: this.campaignId,
        customerId: this.customerId,
        isDeleted: false,
        status: 'active'
      });
      
      if (existingVote && !campaign.votingRules.allowMultipleVotes) {
        throw new Error('Customer has already voted in this campaign');
      }
      
      if (existingVote && campaign.votingRules.allowMultipleVotes) {
        // Set vote number
        const voteCount = await mongoose.model('Vote').countDocuments({
          campaignId: this.campaignId,
          customerId: this.customerId,
          isDeleted: false,
          status: 'active'
        });
        
        if (voteCount >= campaign.votingRules.maxVotesPerCustomer) {
          throw new Error(`Maximum votes (${campaign.votingRules.maxVotesPerCustomer}) reached for this customer`);
        }
        
        this.voteNumber = voteCount + 1;
      }
      
      this.canChange = campaign.votingRules.voteChangeAllowed;
      
      // Get the item image at time of voting
      const item = campaign.items.find(i => 
        i.itemId === this.itemId || i._id.toString() === this.itemId
      );
      
      if (item && item.images && item.images.length > 0) {
        const primaryImage = item.images.find(img => img.isPrimary) || item.images[0];
        this.itemImageAtVote = primaryImage.url;
      }
    }
    
    // Update campaign unique voters count (only for first vote)
    const existingVoter = await mongoose.model('Vote').findOne({
      campaignId: this.campaignId,
      customerId: this.customerId,
      isDeleted: false
    });
    
    if (!existingVoter) {
      await VotingCampaign.findByIdAndUpdate(this.campaignId, {
        $inc: { uniqueVoters: 1 }
      });
    }
  }
  
  next();
});

// Post-save middleware
voteSchema.post('save', async function(doc) {
  if (doc.isNew && doc.status === 'active' && !doc.previousVotes.length) {
    // Update campaign vote counts (only for new votes, not changes)
    const VotingCampaign = mongoose.model('VotingCampaign');
    await VotingCampaign.findByIdAndUpdate(doc.campaignId, {
      $inc: { totalVotes: 1 }
    });
    
    // Update item vote count
    await VotingCampaign.updateOne(
      { 
        _id: doc.campaignId,
        'items.itemId': doc.itemId
      },
      { $inc: { 'items.$.votesCount': 1 } }
    );
  }
});

module.exports = mongoose.model('Vote', voteSchema);