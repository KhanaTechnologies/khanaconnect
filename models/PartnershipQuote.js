const mongoose = require('mongoose');
const crypto = require('crypto');

const selectionSchema = new mongoose.Schema(
  {
    needsStore: { type: Boolean, default: false },
    needsBookings: { type: Boolean, default: false },
    needsRevenueTools: { type: Boolean, default: false },
    needsCustom: { type: Boolean, default: false },
    customScope: {
      type: String,
      enum: ['standalone', 'addon'],
      default: 'standalone',
    },
    customBrief: { type: String, default: '', trim: true, maxlength: 2000 },
    wantsStandaloneApi: { type: Boolean, default: false },
    hasExistingWebsite: { type: Boolean, default: null },
    existingWebsiteUrl: { type: String, default: '', trim: true, maxlength: 500 },
    /** @deprecated use existingWebsitePath — kept for legacy quotes */
    wantsWebsiteRebuild: { type: Boolean, default: false },
    existingWebsitePath: {
      type: String,
      enum: ['none', 'full_khana', 'keep_hosting_free_rebuild', 'no_rebuild'],
      default: 'none',
    },
    siteSize: { type: String, enum: ['starter', 'established'], default: 'starter' },
    catalogueSize: { type: String, enum: ['standard', 'large'], default: 'standard' },
    teamMembers: { type: Number, default: 1, min: 1, max: 50 },
    advancedEmail: { type: Boolean, default: false },
    customIntegration: { type: Boolean, default: false },
  },
  { _id: false }
);

const estimateSchema = new mongoose.Schema(
  {
    tierId: String,
    tierName: String,
    setupFee: Number,
    monthlyFee: Number,
    includedSeats: Number,
    extraSeats: Number,
    seatMonthlyFee: Number,
    seatMonthly: Number,
    addOnLines: [
      {
        name: String,
        monthly: Number,
        onceOff: Number,
      },
    ],
    totalSetup: Number,
    setupWaiver: Number,
    totalMonthly: Number,
    note: String,
    customDisclaimer: String,
  },
  { _id: false }
);

const partnershipQuoteSchema = new mongoose.Schema(
  {
    quoteId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    prospectName: { type: String, required: true, trim: true },
    businessName: { type: String, default: '', trim: true },
    sourceRef: { type: String, default: '', trim: true },
    createdBy: { type: String, default: '' },
    status: {
      type: String,
      enum: ['draft', 'estimated', 'submitted'],
      default: 'draft',
    },
    selections: { type: selectionSchema, default: () => ({}) },
    estimate: { type: estimateSchema, default: null },
    prospectEmail: { type: String, default: '', trim: true, lowercase: true },
    prospectPhone: { type: String, default: '', trim: true },
    submittedAt: { type: Date, default: null },
    validUntil: { type: Date, default: null },
    pricingConfigVersion: { type: Number, default: null },
    followUpEmails: [
      {
        templateId: String,
        templateLabel: String,
        subject: String,
        sentAt: { type: Date, default: Date.now },
        sentBy: String,
      },
    ],
  },
  { timestamps: true }
);

partnershipQuoteSchema.statics.generateQuoteId = function generateQuoteId() {
  return `pq_${crypto.randomBytes(8).toString('hex')}`;
};

partnershipQuoteSchema.index({ createdAt: -1 });

module.exports = mongoose.model('PartnershipQuote', partnershipQuoteSchema);
