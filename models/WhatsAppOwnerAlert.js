const mongoose = require('mongoose');

/** One row per owner alert sent, so the same booking/order never alerts the owner twice. */
const whatsAppOwnerAlertSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true },
    key: { type: String, required: true },
    wamid: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

whatsAppOwnerAlertSchema.index({ client_id: 1, key: 1 }, { unique: true });
whatsAppOwnerAlertSchema.index({ created_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model('WhatsAppOwnerAlert', whatsAppOwnerAlertSchema);
