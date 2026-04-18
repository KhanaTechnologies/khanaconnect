const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { encrypt, decrypt } = require('../helpers/encryption');

// Create a custom setter/getter for encrypted fields
const encryptedString = {
  type: String,
  set: function(value) {
    if (!value) return value;
    // Only encrypt if it's not already encrypted
    if (typeof value === 'string' && !value.includes(':')) {
      return encrypt(value);
    }
    return value;
  },
  get: function(value) {
    if (!value) return value;
    return decrypt(value);
  }
};

const clientSchema = new Schema({
  clientID: { type: String, required: true, unique: true },
  companyName: { type: String, required: true },
  merchant_id: {type: Number, required: true, unique: true},
  merchant_key: {type: String, required: true, unique: true},
  passphrase : {type: String, required: true, unique: true},
  password: {type: String, required: true}, // already has encryption with bcrypt
  token: {type: String, required: true, unique: true},
  return_url: {type: String, required: true},
  
  // Encrypted fields
  businessEmail: encryptedString,
  businessEmailPassword: encryptedString,
  cancel_url: {type: String, required: true},
  notify_url: {type: String, required: true},
  sessionToken: { type: String, default: null },
  sessionExpires: { type: Date, default: null },
  isLoggedIn: { type: Boolean, default: false },
  tier:  {type: String, 
    enum: ["bronze", "silver" , "gold"],
    required: true, 
    default: "bronze"
  },
  role: { 
    type: String, 
    enum: ["client", "admin"],
    required: true, 
    default: "client"
  },
  permissions: {
    bookings: { type: Boolean, default: false },
    orders: { type: Boolean, default: false },
    staff: { type: Boolean, default: false },
    categories: { type: Boolean, default: false },
    preorder: { type: Boolean, default: false },
    voting: { type: Boolean, default: false },
    sales: { type: Boolean, default: false },
    services:  { type: Boolean, default: false },
    products: { type: Boolean, default: false },
    dashboard: { type: Boolean, default: false }
  },
  deliveryOptions: [
    {
      type: { type: String },
      price: { type: Number }
    }
  ],
  emailSignature: { type: String },
  /** Outgoing SMTP (optional). If empty, derived from imapHost or business email domain — not from return_url alone when email domain exists. */
  smtpHost: { type: String, default: '' },
  smtpPort: { type: Number, default: 587 },
  /** Incoming IMAP (optional). If empty, derived from business email domain or return_url. */
  imapHost: { type: String, default: '' },
  imapPort: { type: Number, default: 993 },
  ga4PropertyId: encryptedString, // Now encrypted
  
  // Encrypted Google Analytics Configuration
  analyticsConfig: {
    googleAnalytics: {
      measurementId: encryptedString,
      apiSecret: encryptedString,
      propertyId: encryptedString,
      isEnabled: { type: Boolean, default: false }
    }
  },
  
  // Encrypted Meta (Facebook) Ads Configuration
  metaAds: {
    pixelId: encryptedString,
    accessToken: encryptedString,
    testEventCode: encryptedString,
    apiVersion: { type: String, default: 'v18.0' },
    enabled: { type: Boolean, default: false },
    lastSync: { type: Date },
    status: { 
      type: String, 
      enum: ['active', 'inactive', 'error'],
      default: 'inactive'
    },
    errorMessage: { type: String, default: '' }
  },
  
  // Encrypted Google Ads Configuration
  googleAds: {
    conversionId: encryptedString,
    apiKey: encryptedString,
    developerToken: encryptedString,
    clientId: encryptedString,
    clientSecret: encryptedString,
    refreshToken: encryptedString,
    customerId: encryptedString,
    conversionActionId: encryptedString,
    enabled: { type: Boolean, default: false },
    lastSync: { type: Date },
    status: { 
      type: String, 
      enum: ['active', 'inactive', 'error'],
      default: 'inactive'
    },
    errorMessage: { type: String, default: '' }
  },
  
  // Encrypted TikTok Ads Configuration
  tiktokAds: {
    pixelId: encryptedString,
    accessToken: encryptedString,
    enabled: { type: Boolean, default: false }
  },
  
  // Encrypted Pinterest Ads Configuration
  pinterestAds: {
    adAccountId: encryptedString,
    accessToken: encryptedString,
    enabled: { type: Boolean, default: false }
  },
  
  // Non-encrypted fields (no sensitive data)
  trackingSettings: {
    batchSize: { type: Number, default: 50, min: 1, max: 100 },
    retryAttempts: { type: Number, default: 3, min: 1, max: 10 },
    retryDelayMs: { type: Number, default: 5000, min: 1000, max: 60000 },
    sendAnonymousEvents: { type: Boolean, default: true },
    sendAuthenticatedEvents: { type: Boolean, default: true },
    eventTypes: { 
      type: [String], 
      default: ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'PURCHASE', 'LEAD'],
      enum: ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'INITIATE_CHECKOUT', 'PURCHASE', 'LEAD']
    }
  },
  
  trackingStats: {
    eventsSent: { type: Number, default: 0 },
    eventsFailed: { type: Number, default: 0 },
    lastEventSent: { type: Date },
    dailyQuota: { type: Number, default: 10000 },
    monthlyQuota: { type: Number, default: 300000 }
  }
}, {
  timestamps: true,
  toJSON: { getters: true }, // Important: This ensures getters run when converting to JSON
  toObject: { getters: true } // Important: This ensures getters run when converting to objects
});

// Virtual to check if any ad platform is enabled
clientSchema.virtual('hasEnabledAdPlatforms').get(function() {
  return this.metaAds.enabled || this.googleAds.enabled;
});

// Method to get enabled ad platforms
clientSchema.methods.getEnabledAdPlatforms = function() {
  const platforms = [];
  if (this.metaAds.enabled) platforms.push('meta');
  if (this.googleAds.enabled) platforms.push('google');
  return platforms;
};

// Method to validate ad platform configuration
clientSchema.methods.validateAdConfig = function(platform) {
  switch(platform) {
    case 'meta':
      return !!(this.metaAds.pixelId && this.metaAds.accessToken);
    case 'google':
      return !!(this.googleAds.conversionId && this.googleAds.apiKey);
    default:
      return false;
  }
};

// Method to get decrypted values for specific fields (useful when you need the actual values)
clientSchema.methods.getDecryptedField = function(fieldPath) {
  const value = this.get(fieldPath);
  return decrypt(value);
};

// Pre-save middleware to ensure all encrypted fields are properly encrypted
clientSchema.pre('save', function(next) {
  // The setters will automatically encrypt fields marked as encryptedString
  // This middleware just ensures we handle any special cases
  next();
});

clientSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

clientSchema.set('toJSON', { virtuals: true, getters: true });
clientSchema.set('toObject', { virtuals: true, getters: true });

const Client = mongoose.model('Client', clientSchema);
module.exports = Client;