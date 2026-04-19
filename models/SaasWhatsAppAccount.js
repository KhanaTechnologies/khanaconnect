const mongoose = require('mongoose');

const saasWhatsAppAccountSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    waba_id: { type: String, required: true, trim: true },
    phone_number_id: { type: String, required: true, trim: true },
    access_token_encrypted: { type: String, required: true },
    mode: { type: String, enum: ['embedded', 'manual'], default: 'embedded' },
    status: { type: String, enum: ['active', 'disabled'], default: 'active' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppAccountSchema.index(
  { client_id: 1, phone_number_id: 1 },
  { unique: true }
);

module.exports = mongoose.model('SaasWhatsAppAccount', saasWhatsAppAccountSchema);
