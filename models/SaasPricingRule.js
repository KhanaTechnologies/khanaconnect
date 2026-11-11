const mongoose = require('mongoose');

const saasPricingRuleSchema = new mongoose.Schema(
  {
    service: { type: String, enum: ['whatsapp', 'ads_service_fee'], required: true, index: true },
    message_type: { type: String, enum: ['marketing', 'utility', 'auth', 'service', 'setup', 'management', 'optimization'], default: 'service' },
    /**
     * The plan this rule applies to (starter|launch|growth|scale|enterprise), or "all".
     * bronze/silver/gold are kept only so rules saved before Nov 2026 still load; they match starter/launch/growth.
     */
    tier: {
      type: String,
      enum: ['all', 'starter', 'launch', 'growth', 'scale', 'enterprise', 'bronze', 'silver', 'gold'],
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
