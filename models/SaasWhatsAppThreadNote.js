const mongoose = require('mongoose');

const saasWhatsAppThreadNoteSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    contact_wa_id: { type: String, required: true, trim: true, index: true },
    body: { type: String, required: true, trim: true, maxlength: 2000 },
    author_member_id: { type: String, default: '', trim: true },
    author_name: { type: String, default: '', trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

saasWhatsAppThreadNoteSchema.index({ client_id: 1, contact_wa_id: 1, created_at: -1 });

module.exports = mongoose.model('SaasWhatsAppThreadNote', saasWhatsAppThreadNoteSchema);
