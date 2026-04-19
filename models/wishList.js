const mongoose = require('mongoose');
const Schema = mongoose.Schema;

/**
 * A customer "wish list group" (e.g. Birthday, Kitchen) with line items and optional alerts.
 * @see routes/wishList.js — requires customer JWT (customerID + clientID).
 */
const wishListItemSchema = new Schema(
  {
    product: { type: Schema.Types.ObjectId, ref: 'Product' },
    /** @deprecated migrated to `product` on save */
    productID: { type: String },
    quantity: { type: Number, default: 1, min: 1 },
    /** Matches Product.variants[].name when using a specific variant option. */
    variantName: { type: String, default: '' },
    /** Matches Product.variants[].values[].value */
    variantValue: { type: String, default: '' },
    notifyOnSale: { type: Boolean, default: true },
    notifyOnRestock: { type: Boolean, default: true },
    notes: { type: String, default: '' },
    addedAt: { type: Date, default: Date.now },
    /** Snapshot / last-notified baseline (effective price after sale %). */
    lastKnownEffectivePrice: { type: Number, default: null },
    lastKnownSalePercent: { type: Number, default: null },
    lastKnownStock: { type: Number, default: null },
    lastSaleNotifiedAt: { type: Date, default: null },
    lastRestockNotifiedAt: { type: Date, default: null },
  },
  { _id: true }
);

const wishListSchema = new Schema(
  {
    clientID: { type: String, required: true, index: true },
    customerID: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    sortOrder: { type: Number, default: 0 },
    items: [wishListItemSchema],
  },
  { timestamps: true }
);

wishListSchema.index({ clientID: 1, customerID: 1, name: 1 });

wishListSchema.pre('save', function (next) {
  if (!this.items || !this.items.length) return next();
  for (const it of this.items) {
    if (it.productID && !it.product) it.product = it.productID;
    it.productID = undefined;
    if (!it.product) {
      return next(new Error('Each wish list item must reference a product'));
    }
  }
  next();
});

const WishList = mongoose.model('WishList', wishListSchema);
module.exports = WishList;
