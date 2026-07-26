const mongoose = require('mongoose');

const saasWhatsAppTemplateSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    waba_id: { type: String, default: '', trim: true },
    name: { type: String, required: true, trim: true },
    language: { type: String, required: true, trim: true, default: 'en' },
    status: { type: String, default: '', trim: true, index: true },
    category: { type: String, default: '', trim: true },
    components: { type: mongoose.Schema.Types.Mixed, default: [] },
    synced_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppTemplateSchema.index({ client_id: 1, name: 1, language: 1 }, { unique: true });
saasWhatsAppTemplateSchema.index({ client_id: 1, status: 1 });

module.exports = mongoose.model('SaasWhatsAppTemplate', saasWhatsAppTemplateSchema);
