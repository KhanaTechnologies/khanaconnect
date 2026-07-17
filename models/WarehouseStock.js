const mongoose = require('mongoose');

const warehouseStockSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    variantName: { type: String, default: '' },
    variantValue: { type: String, default: '' },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    reservedQuantity: { type: Number, min: 0, default: 0 },
    reorderLevel: { type: Number, min: 0, default: 0 },
    lastLowStockAlertAt: { type: Date, default: null },
    lastAlertAvailableQty: { type: Number, default: null },
  },
  { timestamps: true }
);

warehouseStockSchema.index(
  { clientID: 1, warehouseId: 1, productId: 1, variantName: 1, variantValue: 1 },
  { unique: true }
);

warehouseStockSchema.virtual('availableQuantity').get(function availableQuantity() {
  return Math.max(0, (this.quantity || 0) - (this.reservedQuantity || 0));
});

warehouseStockSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('WarehouseStock', warehouseStockSchema);
