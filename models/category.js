const mongoose = require('mongoose');

const categorySchema = mongoose.Schema({
    name: {type: String, required: true},
    image: { type: String }, // image URL
    icon: {type: String},
    color: {type: String},
    clientID: {type: String},
});

categorySchema.virtual('id').get(function () {return this._id.toHexString();});
categorySchema.set('toJSON', {virtuals: true,});
exports.Category = mongoose.model('Category', categorySchema);