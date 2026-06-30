const mongoose = require('mongoose');

const discountCodeSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
  },
  code: { type: String, required: true, unique: true },
  clientID: { type: String, required: true },
  usageLimit: { type: Number, default: 1 },
  usageCount: { type: Number, default: 0 },
  discount: { type: Number, required: true },
  appliesTo: [{
    type: mongoose.Schema.Types.ObjectId,
    refPath: 'appliesToModel',
  }],
  appliesToModel: {
    type: String,
    enum: ['Product', 'Service'],
    required: true,
  },
  isActive: { type: Boolean, default: true },
  type: { type: String, enum: ['product', 'category', 'all'], default: 'all' },
  isReferral: { type: Boolean, default: false },
  referrerCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
  referrerLabel: { type: String, default: '' },
}, { timestamps: true });

discountCodeSchema.index({ clientID: 1, isReferral: 1 });
discountCodeSchema.index({ clientID: 1, referrerCustomerId: 1 });

module.exports = mongoose.model('DiscountCode', discountCodeSchema);
