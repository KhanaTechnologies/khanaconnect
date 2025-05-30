const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema({
    name: { type: String, required: true },  // e.g., "Size", "Color", "Material"
    values: [
        {
            value: { type: String, required: true },  // e.g., "Red", "M", "Cotton"
            price: { type: Number, required: true },  // Price difference for this variant
            stock: { type: Number, required: true }   // Stock available for this option
        }
    ]
});

const productSchema = new mongoose.Schema({
    productName: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    richDescription: { type: String, default: "" },
    price: { type: Number, required: true },
    salePercentage: { type: Number, min: 0, max: 100, default: 0 }, // Sale percentage (0-100)
    countInStock: { type: Number, required: true, min: 0 },
    images: [{ type: String }], // Array of image URLs
    brand: { type: String, default: "" },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    rating: { type: Number, default: 0 },
    ingredients : {type: String,default: "Ingredients information not available."},
    usage:{type: String, default: "Usage information not available"},
    numReviews: { type: Number, default: 0 },
    isFeatured: { type: Boolean, default: false },
    clientID: { type: String, required: true }, // Assuming client ID is stored as a string
    variants: [variantSchema] // ✅ Store dynamic variants
}, { timestamps: true });

productSchema.virtual('id').get(function (){return this._id.toHexString();});
productSchema.set('toJSON', {virtuals: true,});
module.exports = mongoose.model('Product', productSchema);
