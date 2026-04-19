const mongoose = require('mongoose');

const saasBillingAccountSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, unique: true, index: true },
    credit_balance: { type: Number, default: 0, min: 0 },
    total_spent: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('SaasBillingAccount', saasBillingAccountSchema);
