const mongoose = require('mongoose');

const warehouseLowStockAlertSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantName: { type: String, default: '' },
    variantValue: { type: String, default: '' },
    availableQuantity: { type: Number, required: true },
    threshold: { type: Number, required: true },
    severity: { type: String, enum: ['low', 'out'], default: 'low' },
    notifiedEmails: [{ type: String }],
    emailSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

warehouseLowStockAlertSchema.index({ clientID: 1, createdAt: -1 });

module.exports = mongoose.model('WarehouseLowStockAlert', warehouseLowStockAlertSchema);
