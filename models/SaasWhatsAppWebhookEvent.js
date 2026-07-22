const mongoose = require('mongoose');

/**
 * Raw Meta WhatsApp webhook payloads (audit / reprocess).
 * Saved before inbox ingest so processing bugs cannot permanently drop messages.
 */
const saasWhatsAppWebhookEventSchema = new mongoose.Schema(
  {
    phone_number_id: { type: String, default: '', index: true },
    inbound_count: { type: Number, default: 0 },
    status_count: { type: Number, default: 0 },
    processed: { type: Boolean, default: false, index: true },
    process_error: { type: String, default: '' },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppWebhookEventSchema.index({ created_at: -1 });

module.exports = mongoose.model('SaasWhatsAppWebhookEvent', saasWhatsAppWebhookEventSchema);
