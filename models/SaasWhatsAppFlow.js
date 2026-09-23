const mongoose = require('mongoose');

const saasWhatsAppFlowSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    waba_id: { type: String, default: '', trim: true },
    flow_id: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    status: { type: String, default: '', trim: true, index: true },
    categories: { type: [String], default: [] },
    starter_id: { type: String, default: '', trim: true },
    cta_default: { type: String, default: 'Open', trim: true },
    body_default: { type: String, default: '', trim: true },
    synced_at: { type: Date, default: null },
    published_at: { type: Date, default: null },
    last_error: { type: String, default: '', trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppFlowSchema.index({ client_id: 1, flow_id: 1 }, { unique: true });
saasWhatsAppFlowSchema.index({ client_id: 1, name: 1 });

module.exports = mongoose.model('SaasWhatsAppFlow', saasWhatsAppFlowSchema);
