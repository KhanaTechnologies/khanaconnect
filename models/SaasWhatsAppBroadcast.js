const mongoose = require('mongoose');

const saasWhatsAppBroadcastSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    name: { type: String, default: '', trim: true, maxlength: 120 },
    template_name: { type: String, required: true, trim: true },
    template_language: { type: String, default: 'en', trim: true },
    status: {
      type: String,
      enum: ['draft', 'queued', 'running', 'completed', 'failed', 'cancelled'],
      default: 'draft',
      index: true,
    },
    recipient_wa_ids: {
      type: [String],
      default: [],
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.length <= 200;
        },
        message: 'At most 200 recipients per broadcast',
      },
    },
    next_index: { type: Number, default: 0 },
    stats: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },
    created_by: { type: String, default: '', trim: true },
    error: { type: String, default: '', trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppBroadcastSchema.index({ client_id: 1, created_at: -1 });

module.exports = mongoose.model('SaasWhatsAppBroadcast', saasWhatsAppBroadcastSchema);
