const mongoose = require('mongoose');

const saasUsageEventSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    service: { type: String, enum: ['whatsapp', 'ads_service_fee'], required: true, index: true },
    message_type: { type: String, enum: ['marketing', 'utility', 'auth', 'service', 'setup', 'management', 'optimization'], default: 'service' },
    units: { type: Number, default: 1, min: 1 },
    source_ref: { type: String, required: true, index: true },
    status: { type: String, enum: ['queued', 'processed', 'failed'], default: 'queued', index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasUsageEventSchema.index({ client_id: 1, source_ref: 1 }, { unique: true });

module.exports = mongoose.model('SaasUsageEvent', saasUsageEventSchema);
