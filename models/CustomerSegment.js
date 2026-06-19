const mongoose = require('mongoose');

const customerSegmentSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 500 },
    /** Preset segments use built-in query logic; custom reserved for future rule builder. */
    preset: {
      type: String,
      enum: [
        'cart_abandoned',
        'wishlist_savers',
        'high_value',
        'inactive_60',
        'product_buyers',
        'service_bookers',
        'newsletter_subscribers',
        'custom',
      ],
      default: 'custom',
    },
    isActive: { type: Boolean, default: true },
    /** Optional product/service ids for scoped segments */
    scopeIds: [{ type: String }],
  },
  { timestamps: true }
);

customerSegmentSchema.index({ clientID: 1, name: 1 });

module.exports = mongoose.model('CustomerSegment', customerSegmentSchema);
