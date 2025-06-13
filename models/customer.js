const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const customerSchema = new Schema({

  clientID: { type: String, required: true }, // Reference to the client
  customerFirstName: { type: String, required: true },
  customerLastName: { type: String, required: true },
  emailAddress: { type: String, required: true},
  phoneNumber:{type: Number,default: ''},
  passwordHash: {type: String, required: true,},
  // Other customer-related fields
  address: {type: String, default: ''},
  city: {type: String, default: ''},
  postalCode: {type: String, default: ''},
  isVerified: {type:Boolean, default: false},
  resetPasswordToken: {type:String, default: ''},
  resetPasswordExpires: {type:Date, default: ''}
});

customerSchema.virtual('id').get(function (){return this._id.toHexString();});
customerSchema.set('toJSON', {virtuals: true,});

const Customer = mongoose.model('Customer', customerSchema);

module.exports = Customer;
