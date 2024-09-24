const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Variant Schema
const variantSchema = new Schema({
  value: { type: String, required: true },
  price: { type: Number, required: true, default: 0 },
  quantity: { type: Number, required: true, default: 0 }
});

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
  clientID: { type: String, required: true }, // Assuming client ID is stored as a string
  dateCreated: { type: Date, default: Date.now },
  sizes: [variantSchema], // Array of objects representing size variants
  colors: [variantSchema], // Array of objects representing color variants
  materials: [variantSchema], // Array of objects representing material variants
  styles: [variantSchema], // Array of objects representing style variants
  titles: [variantSchema] // Array of objects representing title variants
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
