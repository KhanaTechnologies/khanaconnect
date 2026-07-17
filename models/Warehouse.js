const mongoose = require('mongoose');

const warehouseSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    address: { type: String, default: '' },
    city: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    phone: { type: String, default: '' },
    isDefault: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
    priority: { type: Number, default: 0 },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

warehouseSchema.index({ clientID: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Warehouse', warehouseSchema);
