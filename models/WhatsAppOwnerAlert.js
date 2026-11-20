const mongoose = require('mongoose');

/** One row per owner alert, so the same booking/order never alerts the owner twice. Also records how it went out, for the email fallback. */
const whatsAppOwnerAlertSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true },
    key: { type: String, required: true },
    wamid: { type: String, default: '' },
    event: { type: String, default: '' },
    headline: { type: String, default: '' },
    details: { type: String, default: '' },
    /** whatsapp | email | none */
    channel: { type: String, default: '' },
    /** Account the WhatsApp went out from (Khana's number, or the client's own). */
    sender_client_id: { type: String, default: '' },
    to: { type: String, default: '' },
    email_sent_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

whatsAppOwnerAlertSchema.index({ client_id: 1, key: 1 }, { unique: true });
whatsAppOwnerAlertSchema.index({ wamid: 1 }, { sparse: true });
whatsAppOwnerAlertSchema.index({ created_at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model('WhatsAppOwnerAlert', whatsAppOwnerAlertSchema);
