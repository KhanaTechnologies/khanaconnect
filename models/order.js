const mongoose = require('mongoose');

const orderSchema = mongoose.Schema({
    orderItems: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'OrderItem',
        required: true
    }],
    address: { type: String, required: true },
    phone: { type: String, required: true },
    postalCode: { type: String, required: true },
    deliveryType: { type: String, required: true },
    deliveryPrice: { type: Number, required: true },
    status: { type: String, required: true, default: 'Pending' },
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

    // Fields for checkout code functionality
    checkoutCode: { type: mongoose.Schema.Types.ObjectId, ref: 'DiscountCode', required: false },  // Reference to DiscountCode
    discountAmount: { type: Number, default: 0 },  // Discount amount calculated from the checkout code
    finalPrice: { type: Number, required: true },  // Final price after applying the discount
});

// Virtual for calculating the final price after applying the discount
orderSchema.virtual('finalPriceCalculated').get(function() {
    if (this.discountAmount > 0) {
        return this.totalPrice - this.discountAmount + this.deliveryPrice;
    }
    return this.totalPrice + this.deliveryPrice;
});

orderSchema.set('toJSON', { virtuals: true });

exports.Order = mongoose.model('Order', orderSchema);
