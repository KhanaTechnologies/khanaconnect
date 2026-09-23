const mongoose = require('mongoose');

const saasBillingAccountSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, unique: true, index: true },
    /** Synced total = included + purchased (kept for existing gates). */
    credit_balance: { type: Number, default: 0, min: 0 },
    /** Partnership monthly grant — expires when period rolls. */
    included_credit_balance: { type: Number, default: 0, min: 0 },
    /** Prepaid packs / EFT / manual — never expire. */
    purchased_credit_balance: { type: Number, default: 0, min: 0 },
    /** YYYY-MM of last included grant (Africa/Johannesburg). */
    included_period: { type: String, default: '', trim: true },
    /** One-time migration of legacy credit_balance → purchased. */
    pools_migrated: { type: Boolean, default: false },
    total_spent: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

module.exports = mongoose.model('SaasBillingAccount', saasBillingAccountSchema);
