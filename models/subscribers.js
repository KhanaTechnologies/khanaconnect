const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const subscriberSchema = new Schema({
  subscriberID: { type: String, required: true, unique: true },
  clientID: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  // Other subscriber-related fields
}, { timestamps: true });

subscriberSchema.virtual('id').get(function (){return this._id.toHexString();});
subscriberSchema.set('toJSON', {virtuals: true,});
const Subscriber = mongoose.model('Subscriber', subscriberSchema);

module.exports = Subscriber;
