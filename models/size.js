const mongoose = require('mongoose');

const sizeSchema = mongoose.Schema({
    name: {type: String, required: true},
    description: {type: String},
    clientID: {type: String},
});

sizeSchema.virtual('id').get(function () {return this._id.toHexString();});
sizeSchema.set('toJSON', {virtuals: true,});
exports.Size = mongoose.model('Size', sizeSchema);
