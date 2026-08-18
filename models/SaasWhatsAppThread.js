const mongoose = require('mongoose');

/**
 * Per-conversation metadata (assignment, stage, labels, opt-out) for WhatsApp inbox threads.
 * Keyed by (client_id, contact_wa_id).
 */
const saasWhatsAppThreadSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    contact_wa_id: { type: String, required: true, trim: true },
    assigned_member_id: { type: String, default: '', trim: true, index: true },
    assigned_name: { type: String, default: '', trim: true },
    assigned_at: { type: Date, default: null },
    stage: {
      type: String,
      enum: ['open', 'waiting', 'closed'],
      default: 'open',
      index: true,
    },
    labels: {
      type: [String],
      default: [],
      validate: {
        validator(arr) {
          return Array.isArray(arr) && arr.length <= 20;
        },
        message: 'At most 20 labels allowed',
      },
    },
    marketing_opt_out: { type: Boolean, default: false },
    /** Click-to-WhatsApp click id from inbound ad referral (Conversions API). */
    ctwa_clid: { type: String, default: '', trim: true },
    ctwa_clid_at: { type: Date, default: null },
    /** Last inbound timestamp we emailed about for the 24h session window closing. */
    window_close_alert_inbound_at: { type: Date, default: null },
    window_close_alert_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppThreadSchema.index({ client_id: 1, contact_wa_id: 1 }, { unique: true });
saasWhatsAppThreadSchema.index({ client_id: 1, stage: 1 });
saasWhatsAppThreadSchema.index({ client_id: 1, labels: 1 });
saasWhatsAppThreadSchema.index({ client_id: 1, marketing_opt_out: 1 });

module.exports = mongoose.model('SaasWhatsAppThread', saasWhatsAppThreadSchema);
