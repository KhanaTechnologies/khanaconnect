const mongoose = require('mongoose');
const crypto = require('crypto');

const selectionSchema = new mongoose.Schema(
  {
    needsStore: { type: Boolean, default: false },
    needsBookings: { type: Boolean, default: false },
    needsRevenueTools: { type: Boolean, default: false },
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
    totalMonthly: Number,
    note: String,
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
    pricingConfigVersion: { type: Number, default: null },
  },
  { timestamps: true }
);

partnershipQuoteSchema.statics.generateQuoteId = function generateQuoteId() {
  return `pq_${crypto.randomBytes(8).toString('hex')}`;
};

module.exports = mongoose.model('PartnershipQuote', partnershipQuoteSchema);
