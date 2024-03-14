const mongoose = require('mongoose');
const Schema = mongoose.Schema;

// Product Schema
const productSchema = new Schema({
  productName: {type: String,required: true},
  description: {type: String,required: true},
  price: {type: Number,required: true,default:0},
  richDescription: {type: String,default: ''},
  image:{type: String,default: ''},
  images:[{type: String}],
brand: {type : String,default: ''},
category: {type: mongoose.Schema.Types.ObjectId,ref: 'Category',required: true},
countInStock: {type: Number,required: true,min: 0,max: 255},
rating: {type: Number,default: 0,},
numReviews: {type: Number,default: 0,},
isFeatured: {type: Boolean,default: false,},
  // Reference to the Client model
  client: {
    //type: Schema.Types.ObjectId,
    //ref: 'Client',
    type: String,
    required: true
  },
  dateCreated: {type: Date,default: Date.now,},
});

// Product Model

productSchema.virtual('id').get(function (){return this._id.toHexString();});
productSchema.set('toJSON', {virtuals: true,});
const Product = mongoose.model('Product', productSchema);
module.exports = Product;
