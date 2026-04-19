const mongoose = require('mongoose');

const saasPricingRuleSchema = new mongoose.Schema(
  {
    service: { type: String, enum: ['whatsapp', 'ads_service_fee'], required: true, index: true },
    message_type: { type: String, enum: ['marketing', 'utility', 'auth', 'service', 'setup', 'management', 'optimization'], default: 'service' },
    /** Matches Client.tier; use "all" for rules that apply to every tier. */
    tier: {
      type: String,
      enum: ['all', 'bronze', 'silver', 'gold'],
      default: 'all',
      index: true,
    },
    cost_per_unit: { type: Number, required: true, min: 0 },
    markup_percentage: { type: Number, required: true, min: 0 },
    active: { type: Boolean, default: true, index: true },
    updated_by: { type: String, required: true },
    notes: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasPricingRuleSchema.index({ service: 1, message_type: 1, tier: 1, active: 1 });

module.exports = mongoose.model('SaasPricingRule', saasPricingRuleSchema);
