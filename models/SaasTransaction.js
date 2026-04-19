const mongoose = require('mongoose');

const saasTransactionSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    type: { type: String, enum: ['topup', 'deduction'], required: true, index: true },
    amount: { type: Number, required: true, min: 0 },
    credits: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ['payfast', 'manual', 'internal'], default: 'internal' },
    reference: { type: String, required: true, trim: true, index: true },
    status: { type: String, enum: ['success', 'failed', 'pending'], default: 'success', index: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('SaasTransaction', saasTransactionSchema);
