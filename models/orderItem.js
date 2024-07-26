const mongoose = require('mongoose');



const orderItemSchema = mongoose.Schema({
    quantity: {
        type:Number,
        required: true
    },
    product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
    },
    size: {type:String}, // Array of objects representing size variants
    color: {type:String}, // Array of objects representing color variants
    material:{type:String}, // Array of objects representing material variants
    style: {type:String}, // Array of objects representing style variants
    title: {type:String}, // Array of objects representing title variants
})

orderItemSchema.virtual('id').get(function (){return this._id.toHexString();});
orderItemSchema.set('toJSON', {virtuals: true,});
exports.OrderItem = mongoose.model('OrderItem', orderItemSchema);
