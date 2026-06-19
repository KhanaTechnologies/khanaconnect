const mongoose = require('mongoose');

const bundleItemSchema = new mongoose.Schema(
  {
    itemType: { type: String, enum: ['product', 'service'], required: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    quantity: { type: Number, default: 1, min: 1 },
  },
  { _id: false }
);

const productBundleSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, default: '', maxlength: 500 },
    items: { type: [bundleItemSchema], validate: [(v) => v.length >= 2, 'Bundle needs at least 2 items'] },
    /** Fixed bundle price (optional). If empty, sum of items minus discountPercent. */
    bundlePrice: { type: Number, min: 0 },
    discountPercent: { type: Number, default: 10, min: 0, max: 100 },
    isActive: { type: Boolean, default: true },
    /** Show as upsell at checkout */
    showAtCheckout: { type: Boolean, default: true },
    imageUrl: { type: String, default: '' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ProductBundle', productBundleSchema);
