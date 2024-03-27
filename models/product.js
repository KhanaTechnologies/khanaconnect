const mongoose = require('mongoose');
const Schema = mongoose.Schema;


// Product Schema
const productSchema = new Schema({
  productName: { type: String, required: true },
  description: { type: String, required: true },
  price: { type: Number, required: true, default: 0 },
  richDescription: { type: String, default: '' },
  images: [{ type: String }], // Array to store multiple images
  brand: { type: String, default: '' },
  category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
  countInStock: { type: Number, required: true, min: 0, max: 255 },
  rating: { type: Number, default: 0 },
  numReviews: { type: Number, default: 0 },
  isFeatured: { type: Boolean, default: false },
  client: { type: String, required: true }, // Assuming client ID is stored as a string
  dateCreated: { type: Date, default: Date.now },
  sizes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Size', required: true }], // Array of objects representing size and quantity
});

// Add a virtual 'id' field to make it compatible with JSON responses
productSchema.virtual('id').get(function() {
  return this._id.toHexString();
});

// Ensure virtual fields are included in JSON responses
productSchema.set('toJSON', { virtuals: true });

// Product Model
const Product = mongoose.model('Product', productSchema);

module.exports = Product;
