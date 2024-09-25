const mongoose = require('mongoose');

const orderSchema = mongoose.Schema({
    orderItems: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'OrderItem',
        required:true
    }],
    address:{type: String,required: true},
    phone :{type: String,required: true,},
    postalCode: {type: String,required: true},
    deliveryType: {type: String,required: true},
    deliveryPrice : {type: Number,required: true}, 
    status:{type: String,required: true,default: 'Pending',},
    totalPrice: {type:Number,},
    customer:{type: mongoose.Schema.Types.ObjectId,ref: 'Customer'},
    dateOrdered: {
        type: Date,
        default: Date.now
    },
    clientID:{type: String,required: true},
    orderTrackingLink:{type: String,required: false},
    orderTrackingCode: {type: String,required: false},
    paid: { type: Boolean, default: false }
});

orderSchema.virtual('id').get(function (){return this._id.toHexString();});
orderSchema.set('toJSON', {virtuals: true,});

exports.Order = mongoose.model('Order', orderSchema);
