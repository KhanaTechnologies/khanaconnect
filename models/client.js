const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { encrypt, decrypt } = require('../helpers/encryption');
const {
  resolveBusinessEmail,
  cpanelMailHostForDomain,
  extractEmailDomain,
} = require('../helpers/mailHost');

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

const metaCampaignSchema = new Schema(
  {
    name: { type: String, required: true },
    objective: { type: String, required: true },
    budget: { type: Number, min: 0 },
    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'archived'],
      default: 'draft',
    },
    meta_campaign_id: { type: String, default: '' },
  },
  { timestamps: true }
);

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
  /** Temporary owner-setup reset (enable with ALLOW_LEGACY_TEAM_PASSWORD_RESET) */
  teamLegacyResetToken: { type: String, select: false, default: null },
  teamLegacyResetExpires: { type: Date, default: null },
  teamLegacyResetEmail: encryptedString,
  tier:  {type: String, 
    enum: ["bronze", "silver" , "gold"],
    required: true, 
    default: "bronze"
  },
  /** Hex brand color for dashboard UI (e.g. #3b6fc9). Empty = Khana default. */
  dashboardThemeColor: { type: String, default: '', trim: true },
  /** Hex accent for emails (newsletters + transactional). Empty = dashboard theme, then Khana default. */
  emailPrimaryColor: { type: String, default: '', trim: true },
  /** Public URL for logo in transactional email banner. Empty = company name text. */
  emailLogoUrl: { type: String, default: '', trim: true },
  /** Monthly partnership billing — access gated when paidUntil lapses. */
  subscription: {
    status: {
      type: String,
      enum: ['trialing', 'active', 'past_due', 'suspended', 'canceled'],
      default: 'active',
    },
    plan: { type: String, default: 'partnership', trim: true },
    billingCycle: {
      type: String,
      enum: ['monthly', 'quarterly', 'yearly', 'custom'],
      default: 'monthly',
    },
    paidUntil: { type: Date, default: null },
    graceUntil: { type: Date, default: null },
    lastPaymentAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    notes: { type: String, default: '', trim: true },
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
    dashboard: { type: Boolean, default: false },
    email_center: { type: Boolean, default: false },
    email_builder: { type: Boolean, default: false },
    newsletter: { type: Boolean, default: false },
  },
  teamActivitySettings: {
    logCategories: {
      team: { type: Boolean, default: true },
      orders: { type: Boolean, default: true },
      products: { type: Boolean, default: true },
      bookings: { type: Boolean, default: true },
      sales: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
      campaigns: { type: Boolean, default: true },
      account: { type: Boolean, default: true },
    },
    notifyCategories: {
      team: { type: Boolean, default: true },
      orders: { type: Boolean, default: false },
      products: { type: Boolean, default: false },
      bookings: { type: Boolean, default: false },
      sales: { type: Boolean, default: false },
      email: { type: Boolean, default: true },
      campaigns: { type: Boolean, default: false },
      account: { type: Boolean, default: true },
    },
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
  smtpPort: { type: Number, default: 465 },
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
    /** Marketing API ad account id (digits only; no act_ prefix). */
    adAccountId: { type: String, default: '' },
    ownershipType: {
      type: String,
      enum: ['agency', 'client'],
      default: 'agency',
    },
    metaBusinessId: { type: String, default: '' },
    partnerRequestId: { type: String, default: '' },
    campaigns: [metaCampaignSchema],
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
  },

  /** Revenue Command Center — feature toggles & business profile */
  revenueSettings: {
    businessType: {
      type: String,
      enum: ['retail', 'services', 'mixed'],
      default: 'mixed',
    },
    cartRecoveryEnabled: { type: Boolean, default: true },
    cartRecoveryAutoReminders: { type: Boolean, default: false },
    winBackEmailsEnabled: { type: Boolean, default: false },
    postPurchaseEmailsEnabled: { type: Boolean, default: false },
    bookingAbandonmentEnabled: { type: Boolean, default: true },
    referralCodesEnabled: { type: Boolean, default: true },
    inventoryPromosEnabled: { type: Boolean, default: false },
    lowStockThreshold: { type: Number, default: 5, min: 1 },
    slowMoverDays: { type: Number, default: 60, min: 7 },
    socialProofEnabled: { type: Boolean, default: false },
    showRecentOrders: { type: Boolean, default: true },
    showWishlistSaves: { type: Boolean, default: true },
    showStockUrgency: { type: Boolean, default: false },
    bundleUpsellsEnabled: { type: Boolean, default: true },
    bookingOptimizerEnabled: { type: Boolean, default: true },
    freeShippingThreshold: { type: Number, default: 0, min: 0 },
  },
}, {
  timestamps: true,
  toJSON: { getters: true }, // Important: This ensures getters run when converting to JSON
  toObject: { getters: true } // Important: This ensures getters run when converting to objects
});

clientSchema.pre('save', function applyCpanelMailDefaults(next) {
  const email = resolveBusinessEmail(this);
  const domain = extractEmailDomain(email);
  if (!domain) return next();

  const mailHost = cpanelMailHostForDomain(domain);
  if (!mailHost) return next();

  if (!String(this.smtpHost || '').trim()) {
    this.smtpHost = mailHost;
    this.smtpPort = 465;
  }
  if (!String(this.imapHost || '').trim()) {
    this.imapHost = mailHost;
  }
  if (!this.imapPort) {
    this.imapPort = 993;
  }
  next();
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

const Client = mongoose.models.Client || mongoose.model('Client', clientSchema);
module.exports = Client;