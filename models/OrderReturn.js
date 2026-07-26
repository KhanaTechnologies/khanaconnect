const mongoose = require('mongoose');

const orderReturnSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    orderItem: { type: mongoose.Schema.Types.ObjectId, ref: 'OrderItem', required: true },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    quantity: { type: Number, required: true, min: 1 },
    reason: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['requested', 'approved', 'rejected'],
      default: 'requested',
    },
    restocked: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('OrderReturn', orderReturnSchema);
