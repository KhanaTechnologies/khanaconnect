const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const clientSchema = new Schema({
  clientID: { type: String, required: true, unique: true },
  companyName: { type: String, required: true },
  merchant_id: {type: Number, required: true, unique: true},
  merchant_key: {type: String, required: true, unique: true},
  passphrase : {type: String, required: true, unique: true},
  password: {type: String, required: true},
  token: {type: String, required: true, unique: true},
  return_url: {type: String, required: true},
  businessEmail:{type: String, required: true, unique: true},
  businessEmailPassword:{type: String, required: true,},
  cancel_url:{type: String, required: true},
  notify_url:{type: String, required: true}
  // DiliveryOptions:[{type: String}],
  // Other client-related fields
});


clientSchema.virtual('id').get(function (){return this._id.toHexString();});
clientSchema.set('toJSON', {virtuals: true,});
const Client = mongoose.model('Client', clientSchema);
module.exports = Client;
