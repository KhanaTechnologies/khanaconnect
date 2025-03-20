const mongoose = require('mongoose');

const salesItemSchema = new mongoose.Schema({
    itemType: {
        type: String,
        enum: ['service', 'product'],
        required: true,  // Ensures the item type is either 'service' or 'product'
    },
    selectedProductIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product', // Reference to Product schema, assuming products are stored in a Product collection
        required: true,
    }],
    discountPercentage: {
        type: Number,
        required: true,
        min: 0,
        max: 100,  // Ensures the discount is within the range of 0-100%
    },
    startDate: {
        type: Date,
        required: true,
    },
    endDate: {
        type: Date,
        required: true,
    },
    clientID: { type: String, required: true }, // Assuming client ID is stored as a string
}, { timestamps: true });

const SalesItem = mongoose.model('SalesItem', salesItemSchema);

module.exports = { SalesItem };
