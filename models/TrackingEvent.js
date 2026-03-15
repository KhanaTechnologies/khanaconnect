const mongoose = require('mongoose');
const crypto = require('crypto');

const trackingEventSchema = new mongoose.Schema({
  clientID: {
    type: String,
    required: [true, 'clientID is required'],
    index: true
  },
  storeId: {
    type: String,
    index: true
  },
  // For authenticated users - reference to Customer model
  customer: {
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Customer', 
    index: true,
    sparse: true
  },
  // For anonymous visitors - generated ID
  anonymousId: {
    type: String,
    index: true,
    sparse: true
  },
  sessionId: {
    type: String,
    required: [true, 'sessionId is required'],
    index: true
  },
  eventType: {
    type: String,
    required: [true, 'eventType is required'],
    enum: ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'PURCHASE', 'LEAD', 'USER_LOGIN', 'USER_LOGOUT'],
    index: true
  },
  productId: {
    type: String,
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  source: {
    type: String,
    default: 'web',
    enum: ['web', 'mobile', 'api']
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  },
  // For deduplication
  eventHash: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  processed: {
    type: Boolean,
    default: false,
    index: true
  },
  processedAt: {
    type: Date
  },
  // Track when anonymous user converts to authenticated
  convertedAt: {
    type: Date,
    index: true
  },
  // Delivery results
  deliveryResults: [{
    platform: String,
    success: Boolean,
    data: mongoose.Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now }
  }],
  deliveryErrors: [{
    platform: String,
    error: String,
    timestamp: { type: Date, default: Date.now }
  }],
  deliveryStatus: {
    type: String,
    enum: ['pending', 'success', 'partial', 'failed'],
    default: 'pending'
  }
}, {
  timestamps: true
});

// Create compound indexes for common queries
trackingEventSchema.index({ clientID: 1, timestamp: -1 });
trackingEventSchema.index({ storeId: 1, timestamp: -1 });
trackingEventSchema.index({ eventType: 1, timestamp: -1 });
trackingEventSchema.index({ customer: 1, timestamp: -1 });
trackingEventSchema.index({ anonymousId: 1, timestamp: -1 });
trackingEventSchema.index({ deliveryStatus: 1, processed: 1 });

// Virtual to get the appropriate user ID for external platforms
trackingEventSchema.virtual('userId').get(function() {
  return this.customer ? this.customer.toString() : this.anonymousId;
});

// Pre-save middleware to ensure we have either customer or anonymousId
trackingEventSchema.pre('save', function(next) {
  if (!this.customer && !this.anonymousId) {
    // Generate anonymous ID if neither exists
    this.anonymousId = this.constructor.generateAnonymousId(
      this.sessionId, 
      this.clientID
    );
  }
  
  // Generate event hash for deduplication if not provided
  if (!this.eventHash) {
    this.eventHash = this.constructor.generateEventHash(this);
  }
  
  next();
});

// Static method to generate anonymous ID
trackingEventSchema.statics.generateAnonymousId = function(sessionId, clientID) {
  const hash = crypto.createHash('sha256')
    .update(`${clientID}_${sessionId}_${Date.now()}`)
    .digest('hex')
    .substring(0, 24);
  
  return `anon_${hash}`;
};

// Static method to generate event hash for deduplication
trackingEventSchema.statics.generateEventHash = function(event) {
  const data = `${event.clientID}-${event.sessionId}-${event.eventType}-${event.productId || ''}-${event.timestamp || Date.now()}`;
  return crypto.createHash('sha256').update(data).digest('hex');
};

// Static method to convert anonymous user to authenticated
trackingEventSchema.statics.convertAnonymousToAuthenticated = async function(
  anonymousId, 
  customerId, 
  clientID
) {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  try {
    // Find all events with this anonymousId
    const events = await this.find({ 
      anonymousId, 
      clientID,
      customer: { $exists: false } 
    }).session(session);
    
    // Update them to reference the customer
    for (const event of events) {
      event.customer = customerId;
      event.convertedAt = new Date();
      event.anonymousId = undefined;
      await event.save({ session });
    }
    
    // Create a conversion event
    if (events.length > 0) {
      await this.create([{
        clientID,
        customer: customerId,
        sessionId: events[0]?.sessionId || 'conversion',
        eventType: 'USER_LOGIN',
        metadata: {
          previousAnonymousId: anonymousId,
          eventsConverted: events.length
        },
        source: 'api',
        convertedAt: new Date()
      }], { session });
    }
    
    await session.commitTransaction();
    return { converted: events.length };
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
};

// Method to prepare event for external platforms
trackingEventSchema.methods.prepareForExternalPlatform = function(platform) {
  const event = this.toObject();
  
  // Helper to hash PII data
  const hashPII = (value) => {
    if (!value) return undefined;
    return crypto.createHash('sha256')
      .update(value.toString().toLowerCase().trim())
      .digest('hex');
  };
  
  // Map event types to platform-specific names
  const mapEventType = (eventType, platform) => {
    const metaMapping = {
      'PAGE_VIEW': 'PageView',
      'PRODUCT_VIEW': 'ViewContent',
      'ADD_TO_CART': 'AddToCart',
      'INITIATE_CHECKOUT': 'InitiateCheckout',
      'PURCHASE': 'Purchase',
      'LEAD': 'Lead',
      'USER_LOGIN': 'CompleteRegistration',
      'USER_LOGOUT': 'UserLogout'
    };
    
    const googleMapping = {
      'PAGE_VIEW': 'page_view',
      'PRODUCT_VIEW': 'view_item',
      'ADD_TO_CART': 'add_to_cart',
      'INITIATE_CHECKOUT': 'begin_checkout',
      'PURCHASE': 'purchase',
      'LEAD': 'generate_lead',
      'USER_LOGIN': 'login',
      'USER_LOGOUT': 'logout'
    };
    
    return platform === 'meta' 
      ? metaMapping[eventType] || eventType
      : googleMapping[eventType] || eventType.toLowerCase();
  };
  
  switch(platform) {
    case 'meta':
      return {
        event_name: mapEventType(event.eventType, 'meta'),
        event_time: Math.floor(new Date(event.timestamp).getTime() / 1000),
        event_source_url: event.metadata?.url,
        action_source: event.source?.toUpperCase() || 'WEBSITE',
        user_data: {
          client_user_agent: event.metadata?.userAgent,
          client_ip_address: event.metadata?.ip,
          em: hashPII(event.metadata?.email),
          ph: hashPII(event.metadata?.phone),
          external_id: event.customer ? hashPII(event.customer.toString()) : 
                      event.anonymousId ? hashPII(event.anonymousId) : undefined
        },
        custom_data: {
          ...event.metadata,
          content_ids: event.productId ? [event.productId] : undefined,
          content_type: event.productId ? 'product' : 'website',
          currency: event.metadata?.currency || 'ZAR',
          value: event.metadata?.price || 0,
          quantity: event.metadata?.quantity || 1
        },
        event_id: event._id?.toString() || event.eventHash,
        event_source: event.source || 'web'
      };
      
    case 'google':
      return {
        conversion_action: mapEventType(event.eventType, 'google'),
        conversion_time: new Date(event.timestamp).toISOString(),
        conversion_value: event.metadata?.price || 0,
        conversion_currency: event.metadata?.currency || 'ZAR',
        user_identifiers: [
          event.customer ? { user_id: event.customer.toString() } : null,
          event.anonymousId ? { anonymous_id: event.anonymousId } : null
        ].filter(Boolean),
        product_details: event.productId ? {
          id: event.productId,
          quantity: event.metadata?.quantity || 1,
          price: event.metadata?.price || 0,
          category: event.metadata?.category
        } : undefined,
        order_id: event.metadata?.orderId,
        gclid: event.metadata?.gclid
      };
      
    default:
      return event;
  }
};

// Method to get external user ID for social platforms
trackingEventSchema.methods.getExternalUserId = function() {
  if (this.customer) {
    return `auth_${this.customer.toString()}`;
  } else if (this.anonymousId) {
    return `anon_${this.anonymousId}`;
  }
  return `sess_${this.sessionId}`;
};

module.exports = mongoose.model('TrackingEvent', trackingEventSchema);