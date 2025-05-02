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
  sessionToken: { type: String, default: null }, // Session token
  sessionExpires: { type: Date, default: null }, // Session expiration
  isLoggedIn: { type: Boolean, default: false },  // Login status
  tier:  {type: String, 
    enum: ["bronze", "silver" , "gold"],  // ✅ Ensures only "Client" or "Admin" are allowed
    required: true, 
    default: "bronze"  // (Optional) Default role is "Client"
    },
  role: { 
    type: String, 
    enum: ["client", "admin"],  // ✅ Ensures only "Client" or "Admin" are allowed
    required: true, 
    default: "Client"  // (Optional) Default role is "Client"
  },
  permissions: {
    bookings: { type: Boolean, default: false },
    orders: { type: Boolean, default: false },
    staff: { type: Boolean, default: false },
    services: { type: Boolean, default: false },
    categories : { type: Boolean, default: false },
    products: { type: Boolean, default: false },
    sales_promotions: { type: Boolean, default: false }
  },
     // ✅ Delivery Options - Array of objects
     deliveryOptions: [
      {
        type: { type: String }, // e.g., "Standard", "Express"
        price: { type: Number } // e.g., 75, 120
      }
    ]

  // Other client-related fields
});

clientSchema.virtual('id').get(function () {
  return this._id.toHexString();
});
clientSchema.set('toJSON', { virtuals: true });

const Client = mongoose.model('Client', clientSchema);
module.exports = Client;
