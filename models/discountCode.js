const mongoose = require('mongoose');

const discountCodeSchema = new mongoose.Schema({
    id: {
        type: String,
        required: true,
        unique: true,
    },
    code: { type: String, required: true, unique: true },  // Discount code (e.g., "SUMMER10")
    clientID: { type: String, required: true },           // The client ID this code applies to
    usageLimit: { type: Number, default: 1 },             // Number of times this code can be used
    usageCount: { type: Number, default: 0 },
    discount: { type: Number, required: true },     
    appliesTo: [{ 
        type: mongoose.Schema.Types.ObjectId, 
        refPath: 'appliesToModel' 
    }],  // List of product or service IDs that apply for the discount
    appliesToModel: { 
        type: String, 
        enum: ['Product', 'Service'],
        required: true 
    },  // Reference to either "Product" or "Service" models
    isActive: { type: Boolean, default: true },           // Whether the discount code is active or not
    type: { type: String, enum: ['product', 'category', 'all'], default: 'all' },
}, { timestamps: true });

module.exports = mongoose.model('DiscountCode', discountCodeSchema);
