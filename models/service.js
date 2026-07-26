const mongoose = require('mongoose');

const serviceSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    price: {
      type: Number,
      required: true,
    },
    clientID: {
      type: String,
      required: true,
    },
    duration: { type: Number, default: 60, min: 5 },
    isActive: { type: Boolean, default: true },
    category: { type: String, default: '', trim: true },
    image: { type: String, default: '' },
    staffIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Staff' }],
    addonIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service' }],
    isPackage: { type: Boolean, default: false },
    packageServiceIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Service' }],
    bufferBeforeMin: { type: Number, default: 0, min: 0 },
    bufferAfterMin: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true }
);

serviceSchema.index({ clientID: 1, isActive: 1 });
serviceSchema.index({ clientID: 1, category: 1 });

module.exports = mongoose.model('Service', serviceSchema);
