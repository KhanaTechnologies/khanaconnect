const mongoose = require('mongoose');

const orderSchema = mongoose.Schema({
    orderItems: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'OrderItem',
        required: true
    }],
    address: { type: String, required: true },
    city: { type: String, default: '' },
    province: { type: String, default: '' },
    country: { type: String, default: 'ZA' },
    phone: { type: String, required: true },
    postalCode: { type: String, required: true },
    deliveryType: { type: String, required: true },
    deliveryPrice: { type: Number, required: true },
    status: { type: String, required: true, default: 'pending' },
    orderNumber: { type: String, default: '', index: true },
    invoiceNumber: { type: String, default: '' },
    totalPrice: { type: Number },
    customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer' },
    dateOrdered: {
        type: Date,
        default: Date.now
    },
    clientID: { type: String, required: true },
    orderTrackingLink: { type: String, required: false },
    orderTrackingCode: { type: String, required: false },
    paid: { type: Boolean, default: false },
    refunded: { type: Boolean, default: false },
    refundedAt: { type: Date, default: null },
    // null/undefined = legacy order (stock already handled under old create path)
    // true = deducted under new helper; false = explicitly not deducted yet (unpaid hold)
    stockDeducted: { type: Boolean, default: null },
    stockRestocked: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },

    // Fields for checkout code functionality
    checkoutCode: {  type: String, required: false },
    discountAmount: { type: Number, default: 0 },
    finalPrice: { type: Number, required: true },
    orderNotes: { type: String, required: false },

    orderType: { type: String, enum: ['retail', 'b2b'], default: 'retail' },
    paymentTerms: { type: String, enum: ['prepaid', 'net30', 'on_account'], default: 'prepaid' },
    poNumber: { type: String, default: '' },
    b2bBuyer: { type: mongoose.Schema.Types.ObjectId, ref: 'B2BBuyer', default: null },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    stockSource: { type: String, enum: ['legacy', 'warehouse'], default: 'legacy' },
});

orderSchema.index({ clientID: 1, orderNumber: 1 });
orderSchema.index({ clientID: 1, deletedAt: 1 });

// Virtual for calculating the final price after applying the discount
orderSchema.virtual('finalPriceCalculated').get(function() {
    if (this.discountAmount > 0) {
        return this.totalPrice - this.discountAmount + this.deliveryPrice;
    }
    return this.totalPrice + this.deliveryPrice;
});

orderSchema.set('toJSON', { virtuals: true });

exports.Order = mongoose.model('Order', orderSchema);
