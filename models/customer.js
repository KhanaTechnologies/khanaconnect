const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const { encrypt, decrypt } = require('../helpers/encryption');

// Create a custom setter/getter for encrypted fields
const encryptedString = {
  type: String,
  set: function(value) {
    if (!value) return value;
    // Only encrypt if it's not already encrypted
    if (typeof value === 'string' && !value.includes(':')) {
      return encrypt(value);
    }
    return value;
  },
  get: function(value) {
    if (!value) return value;
    return decrypt(value);
  }
};

const encryptedNumber = {
  type: Number,
  set: function(value) {
    if (!value) return value;
    // Convert number to string for encryption
    const valueStr = value.toString();
    if (!valueStr.includes(':')) {
      return encrypt(valueStr);
    }
    return value;
  },
  get: function(value) {
    if (!value) return value;
    const decrypted = decrypt(value.toString());
    // Try to convert back to number if it's a number
    const num = parseFloat(decrypted);
    return isNaN(num) ? decrypted : num;
  }
};

const cartItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String, required: true }, // Product name doesn't need encryption
  quantity: { type: Number, default: 1, min: 1 },
  price: { type: Number, required: true }, // Price doesn't need encryption
  image: { type: String, default: '' }, // Image URL doesn't need encryption
  category: { type: String, default: '' }, // Category doesn't need encryption
  variant: {
    name: { type: String, default: '' },
    value: { type: String, default: '' },
    price: { type: Number, default: 0 }
  },
  addedAt: { type: Date, default: Date.now },
  lastAddedAt: { type: Date, default: Date.now }
}, { _id: false });

const orderHistorySchema = new Schema({
  orderId: { type: String, required: true },
  products: [cartItemSchema],
  totalAmount: { type: Number, required: true },
  orderDate: { type: Date, default: Date.now },
  status: { type: String, default: 'completed' }
}, { _id: false });

const customerPreferencesSchema = new Schema({
  favoriteCategories: [{ type: String }], // Categories don't need encryption
  preferredPriceRange: {
    min: { type: Number, default: 0 },
    max: { type: Number, default: 10000 }
  },
  notificationPreferences: {
    cartReminders: { type: Boolean, default: true },
    promotions: { type: Boolean, default: true },
    restockAlerts: { type: Boolean, default: true }
  },
  shoppingHabits: {
    averageOrderValue: { type: Number, default: 0 },
    favoriteProducts: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
    typicalOrderInterval: { type: Number, default: 0 }, // in days
    lastOrderDate: { type: Date }
  }
}, { _id: false });

const cartReminderSchema = new Schema({
  reminderType: { 
    type: String, 
    enum: ['hour', 'day', 'week', 'month', 'custom'],
    default: 'day'
  },
  isActive: { type: Boolean, default: true },
  lastSent: { type: Date },
  nextReminder: { type: Date },
  customHours: { type: Number, default: 24 } // for custom reminder timing
}, { _id: false });

const customerSchema = new Schema({
  clientID: { type: String, required: true }, 
  customerFirstName: { type: String, required: true }, // Name doesn't need encryption
  customerLastName: { type: String, required: true }, // Name doesn't need encryption
  
  // Encrypted fields
  emailAddress: encryptedString, // Now encrypted
  phoneNumber: encryptedNumber, // Now encrypted (as number)
  address: encryptedString, // Now encrypted
  city: encryptedString, // Now encrypted
  postalCode: encryptedString, // Now encrypted
  
  passwordHash: { type: String, required: true }, // Already hashed with bcrypt
  isVerified: { type: Boolean, default: false },
  
  // Cart and Order Data (these contain product references, not PII)
  cart: [cartItemSchema],
  orderHistory: [orderHistorySchema],
  wishlist: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  
  // Preferences and Analytics
  preferences: { type: customerPreferencesSchema, default: () => ({}) },
  cartReminder: { type: cartReminderSchema, default: () => ({}) },
  
  // Authentication fields (tokens don't need encryption as they're temporary)
  resetPasswordToken: { type: String, default: '' },
  resetPasswordExpires: { type: Date },
  emailVerificationToken: { type: String },
  emailVerificationExpires: { type: Date },
  
  // Analytics
  totalOrders: { type: Number, default: 0 },
  totalSpent: { type: Number, default: 0 },
  lastActivity: { type: Date, default: Date.now },
  customerSince: { type: Date, default: Date.now }
}, {
  timestamps: true,
  toJSON: { getters: true }, // Important: This ensures getters run when converting to JSON
  toObject: { getters: true } // Important: This ensures getters run when converting to objects
});

// Indexes for better performance
customerSchema.index({ clientID: 1, emailAddress: 1 });
customerSchema.index({ clientID: 1, lastActivity: -1 });
customerSchema.index({ 'cartReminder.nextReminder': 1 });

customerSchema.virtual('id').get(function () {
  return this._id.toHexString();
});

customerSchema.set('toJSON', {
  virtuals: true,
  getters: true,
  transform: function(doc, ret) {
    delete ret.passwordHash;
    return ret;
  }
});

const Customer = mongoose.model('Customer', customerSchema);
module.exports = Customer;