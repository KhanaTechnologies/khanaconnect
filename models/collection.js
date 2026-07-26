const mongoose = require('mongoose');

const collectionSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, default: '', trim: true },
    description: { type: String, default: '' },
    image: { type: String, default: '' },
    productIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

collectionSchema.index({ clientID: 1, slug: 1 });

module.exports = mongoose.model('Collection', collectionSchema);
