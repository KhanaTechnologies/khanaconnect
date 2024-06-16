const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const wishListSchema = new Schema({
    clientID: { type: String, required: true },
    customerID: { type: String, required: true},
    name: { type: String, required: true },
    items: [
        {
            productID: { type: String },
            quantity : {type: Number, required: true }
        }
    ]
});

const WishList = mongoose.model('WishList', wishListSchema);
module.exports = WishList;
