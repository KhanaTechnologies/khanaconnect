const mongoose = require('mongoose');

/**
 * One WhatsApp Cloud API message (inbound or outbound) for the dashboard inbox.
 * Threads are grouped by (client_id, contact_wa_id).
 */
const saasWhatsAppMessageSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    phone_number_id: { type: String, required: true, trim: true, index: true },
    /** Customer WhatsApp id / E.164 digits without + */
    contact_wa_id: { type: String, required: true, trim: true, index: true },
    contact_name: { type: String, default: '', trim: true },
    direction: { type: String, enum: ['inbound', 'outbound'], required: true, index: true },
    wamid: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['text', 'template', 'image', 'audio', 'video', 'document', 'sticker', 'location', 'contacts', 'interactive', 'reaction', 'unknown'],
      default: 'text',
    },
    body: { type: String, default: '' },
    template_name: { type: String, default: '' },
    status: {
      type: String,
      enum: ['received', 'pending', 'sent', 'delivered', 'read', 'failed'],
      default: 'received',
      index: true,
    },
    error: { type: String, default: '' },
    timestamp: { type: Date, required: true, index: true },
    raw: { type: mongoose.Schema.Types.Mixed, default: null },
    read_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppMessageSchema.index({ client_id: 1, contact_wa_id: 1, timestamp: -1 });
saasWhatsAppMessageSchema.index({ wamid: 1 }, { unique: true });
saasWhatsAppMessageSchema.index({ phone_number_id: 1, contact_wa_id: 1, timestamp: -1 });

module.exports = mongoose.model('SaasWhatsAppMessage', saasWhatsAppMessageSchema);
