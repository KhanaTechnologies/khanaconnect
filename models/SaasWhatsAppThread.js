const mongoose = require('mongoose');

/**
 * Per-conversation metadata (assignment, etc.) for WhatsApp inbox threads.
 * Keyed by (client_id, contact_wa_id).
 */
const saasWhatsAppThreadSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    contact_wa_id: { type: String, required: true, trim: true },
    assigned_member_id: { type: String, default: '', trim: true, index: true },
    assigned_name: { type: String, default: '', trim: true },
    assigned_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppThreadSchema.index({ client_id: 1, contact_wa_id: 1 }, { unique: true });

module.exports = mongoose.model('SaasWhatsAppThread', saasWhatsAppThreadSchema);
