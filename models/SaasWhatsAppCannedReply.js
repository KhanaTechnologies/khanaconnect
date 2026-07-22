const mongoose = require('mongoose');

const saasWhatsAppCannedReplySchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 80 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },
    shortcut: { type: String, default: '', trim: true, maxlength: 40 },
    sort_order: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppCannedReplySchema.index({ client_id: 1, sort_order: 1, title: 1 });

module.exports = mongoose.model('SaasWhatsAppCannedReply', saasWhatsAppCannedReplySchema);
