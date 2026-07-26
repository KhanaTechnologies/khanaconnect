const mongoose = require('mongoose');

const productReviewSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    customerName: { type: String, default: '', trim: true },
    customerEmail: { type: String, default: '', trim: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    title: { type: String, default: '', trim: true, maxlength: 120 },
    body: { type: String, default: '', trim: true, maxlength: 2000 },
    approved: { type: Boolean, default: true },
  },
  { timestamps: true }
);

productReviewSchema.index({ clientID: 1, product: 1, createdAt: -1 });

module.exports = mongoose.model('ProductReview', productReviewSchema);
