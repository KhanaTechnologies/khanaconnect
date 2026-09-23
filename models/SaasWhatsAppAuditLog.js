const mongoose = require('mongoose');

const saasWhatsAppAuditLogSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    actor: { type: String, default: '', trim: true },
    action: { type: String, required: true, trim: true, index: true },
    template_name: { type: String, default: '', trim: true },
    detail: { type: String, default: '', trim: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppAuditLogSchema.index({ client_id: 1, created_at: -1 });

module.exports = mongoose.model('SaasWhatsAppAuditLog', saasWhatsAppAuditLogSchema);
