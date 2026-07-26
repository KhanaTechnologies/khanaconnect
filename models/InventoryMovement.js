const mongoose = require('mongoose');

const inventoryMovementSchema = new mongoose.Schema(
  {
    client_id: { type: String, required: true, index: true },
    product_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    variant_value: { type: String, default: '' },
    delta: { type: Number, required: true },
    reason: { type: String, default: 'adjust', trim: true },
    order_id: { type: String, default: '' },
    note: { type: String, default: '' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

inventoryMovementSchema.index({ client_id: 1, created_at: -1 });

module.exports = mongoose.model('InventoryMovement', inventoryMovementSchema);
