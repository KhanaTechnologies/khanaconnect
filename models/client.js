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
  notify_url:{type: String, required: true},
  sessionToken: { type: String, default: null },
  sessionExpires: { type: Date, default: null },
  isLoggedIn: { type: Boolean, default: false },
  tier:  {type: String, 
    enum: ["bronze", "silver" , "gold"],
    required: true, 
    default: "bronze"
    },
  role: { 
    type: String, 
    enum: ["client", "admin"],
    required: true, 
    default: "client"
  },
  permissions: {
    bookings: { type: Boolean, default: false },
    orders: { type: Boolean, default: false },
    staff: { type: Boolean, default: false },
    categories: { type: Boolean, default: false },
    preorder: { type: Boolean, default: false },
    voting: { type: Boolean, default: false },
    sales: { type: Boolean, default: false },
    services:  { type: Boolean, default: false },
    products: { type: Boolean, default: false }
  },
  deliveryOptions: [
    {
      type: { type: String },
      price: { type: Number }
    }
  ],
  emailSignature: {type: String},
  ga4PropertyId : {type: String},
  // ✅ ADDED: Google Analytics Configuration
  analyticsConfig: {
    googleAnalytics: {
      measurementId: { type: String, default: '' },
      apiSecret: { type: String, default: '' },
      propertyId: { type: String, default: '' },
      isEnabled: { type: Boolean, default: false }
    }
  }
}, {
  timestamps: true
});

clientSchema.virtual('id').get(function () {
  return this._id.toHexString();
});
clientSchema.set('toJSON', { virtuals: true });

const Client = mongoose.model('Client', clientSchema);
module.exports = Client;