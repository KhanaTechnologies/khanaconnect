const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Variant Schema
const variantSchema = new Schema({
    value: { type: String, required: true },
    price: { type: Number, required: true, default: 0 },
    quantity: { type: Number, required: true, default: 0 }
  });
  

const orderItemSchema = mongoose.Schema({
    quantity: {
        type:Number,
        required: true
    },
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
    },
    sizes: [variantSchema], // Array of objects representing size variants
    colors: [variantSchema], // Array of objects representing color variants
    materials: [variantSchema], // Array of objects representing material variants
    styles: [variantSchema], // Array of objects representing style variants
    titles: [variantSchema] // Array of objects representing title variants
})

orderItemSchema.virtual('id').get(function (){return this._id.toHexString();});
orderItemSchema.set('toJSON', {virtuals: true,});
exports.OrderItem = mongoose.model('OrderItem', orderItemSchema);
