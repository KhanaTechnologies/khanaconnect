const mongoose = require('mongoose');

const saasWhatsAppAutoRuleSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    enabled: { type: Boolean, default: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    keywords: {
      type: [String],
      default: [],
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.length <= 40;
        },
        message: 'At most 40 keywords per rule',
      },
    },
    reply: { type: String, required: true, trim: true, maxlength: 1000 },
    match_mode: {
      type: String,
      enum: ['any', 'all', 'short_greeting'],
      default: 'any',
    },
    sort_order: { type: Number, default: 0 },
    cooldown_ms: { type: Number, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppAutoRuleSchema.index({ client_id: 1, sort_order: 1, created_at: 1 });

module.exports = mongoose.model('SaasWhatsAppAutoRule', saasWhatsAppAutoRuleSchema);
