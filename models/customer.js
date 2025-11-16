// models/customer.js
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const cartItemSchema = new Schema({
  productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
  productName: { type: String, required: true },
  quantity: { type: Number, default: 1, min: 1 },
  price: { type: Number, required: true },
  image: { type: String, default: '' },
  category: { type: String, default: '' },
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
  favoriteCategories: [{ type: String }],
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
  customerFirstName: { type: String, required: true },
  customerLastName: { type: String, required: true },
  emailAddress: { type: String, required: true },
  phoneNumber: { type: Number, default: null },
  passwordHash: { type: String, required: true },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
  postalCode: { type: String, default: '' },
  isVerified: { type: Boolean, default: false },
  
  // Cart and Order Data
  cart: [cartItemSchema],
  orderHistory: [orderHistorySchema],
  wishlist: [{ type: Schema.Types.ObjectId, ref: 'Product' }],
  
  // Preferences and Analytics
  preferences: { type: customerPreferencesSchema, default: () => ({}) },
  cartReminder: { type: cartReminderSchema, default: () => ({}) },
  
  // Authentication fields
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
  timestamps: true
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
  transform: function(doc, ret) {
    delete ret.passwordHash;
    return ret;
  }
});

const Customer = mongoose.model('Customer', customerSchema);
module.exports = Customer;