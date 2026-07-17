const mongoose = require('mongoose');

const b2bTierSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    description: { type: String, default: '' },
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

b2bTierSchema.index({ clientID: 1, slug: 1 }, { unique: true });

module.exports = mongoose.model('B2BTier', b2bTierSchema);
