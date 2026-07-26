const mongoose = require('mongoose');

const variantValueSchema = new mongoose.Schema({
  value: { type: String, required: true },
  price: { type: Number, required: true },
  stock: { type: Number, required: true, min: 0 },
  sku: { type: String, default: '', trim: true },
});

const variantSchema = new mongoose.Schema({
  name: { type: String, required: true },
  values: [variantValueSchema],
});

const productSchema = new mongoose.Schema(
  {
    productName: { type: String, required: true, trim: true },
    description: { type: String, required: true },
    richDescription: { type: String, default: '' },
    price: { type: Number, required: true },
    costPrice: { type: Number, min: 0, default: null },
    salePercentage: { type: Number, min: 0, max: 100, default: 0 },
    countInStock: { type: Number, required: true, min: 0 },
    images: [{ type: String }],
    brand: { type: String, default: '' },
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'Category', required: true },
    rating: { type: Number, default: 0 },
    ingredients: { type: String, default: 'Ingredients information not available.' },
    usage: { type: String, default: 'Usage information not available' },
    numReviews: { type: Number, default: 0 },
    isFeatured: { type: Boolean, default: false },
    clientID: { type: String, required: true },
    variants: [variantSchema],

    // Catalog visibility (default published = existing products stay live)
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'published',
      index: true,
    },

    // Identity / shipping / SEO
    sku: { type: String, default: '', trim: true, index: true },
    weightKg: { type: Number, min: 0, default: null },
    lengthCm: { type: Number, min: 0, default: null },
    widthCm: { type: Number, min: 0, default: null },
    heightCm: { type: Number, min: 0, default: null },
    tags: { type: [String], default: [] },
    slug: { type: String, default: '', trim: true, index: true },
    metaTitle: { type: String, default: '', trim: true },
    metaDescription: { type: String, default: '', trim: true },

    // Collections (refs to Collection docs)
    collectionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Collection' }],
  },
  { timestamps: true }
);

productSchema.index({ clientID: 1, status: 1 });
productSchema.index({ clientID: 1, sku: 1 });
productSchema.index({ clientID: 1, slug: 1 });

productSchema.virtual('id').get(function () {
  return this._id.toHexString();
});
productSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Product', productSchema);
