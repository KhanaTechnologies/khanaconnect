const mongoose = require('mongoose');

const b2bPriceListSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    tierId: { type: mongoose.Schema.Types.ObjectId, ref: 'B2BTier', required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    price: { type: Number, required: true, min: 0 },
    minQty: { type: Number, default: 1, min: 1 },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

b2bPriceListSchema.index({ clientID: 1, tierId: 1, productId: 1, minQty: 1 }, { unique: true });

module.exports = mongoose.model('B2BPriceList', b2bPriceListSchema);
