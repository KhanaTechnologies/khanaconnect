const mongoose = require('mongoose');

const { Schema } = mongoose;

const tierSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    tagline: { type: String, default: '' },
    description: { type: String, default: '' },
    setupFee: { type: Number, default: null },
    monthlyFee: { type: Number, default: null },
    setupLabel: { type: String, default: '' },
    monthlyLabel: { type: String, default: '' },
    /** Setup fee may be paid in this many equal monthly instalments (0 = up front only). */
    setupInstalments: { type: Number, default: 0, min: 0, max: 24 },
    featured: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    highlights: { type: [String], default: [] },
  },
  { _id: false }
);

const addOnSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: '' },
    monthlyFee: { type: Number, default: null },
    onceOffFee: { type: Number, default: null },
    pricingType: { type: String, enum: ['monthly', 'once'], default: 'monthly' },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false }
);

const faqSchema = new mongoose.Schema(
  {
    question: { type: String, required: true },
    answer: { type: String, required: true },
    sortOrder: { type: Number, default: 0 },
  },
  { _id: false }
);

const comparisonRowSchema = new mongoose.Schema(
  {
    label: { type: String, required: true },
    // true/false for a tick or cross, or a short value such as "50" (WhatsApp credits per month).
    starter: { type: Schema.Types.Mixed, default: false },
    launch: { type: Schema.Types.Mixed, default: false },
    growth: { type: Schema.Types.Mixed, default: false },
    scale: { type: Schema.Types.Mixed, default: false },
    enterprise: { type: Schema.Types.Mixed, default: false },
  },
  { _id: false, strict: false }
);

const partnershipPricingConfigSchema = new mongoose.Schema(
  {
    configKey: { type: String, required: true, unique: true, default: 'default' },
    pricingConfigVersion: { type: Number, default: 1 },
    showPublishedPrices: { type: Boolean, default: true },
    currency: { type: String, default: 'ZAR' },
    currencySymbol: { type: String, default: 'R' },
    billingNote: { type: String, default: '' },
    vatNote: { type: String, default: '' },
    tiers: { type: [tierSchema], default: [] },
    addOns: { type: [addOnSchema], default: [] },
    faqs: { type: [faqSchema], default: [] },
    comparisonFeatures: { type: [comparisonRowSchema], default: [] },
    planBuilder: {
      includedSeats: { type: mongoose.Schema.Types.Mixed, default: {} },
      extraSeatMonthlyFee: { type: Number, default: 99 },
    },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('PartnershipPricingConfig', partnershipPricingConfigSchema);
