const mongoose = require('mongoose');
const { encrypt, decrypt } = require('../helpers/encryption');

const encryptedString = {
  type: String,
  set(value) {
    if (!value) return value;
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : value;
    if (typeof normalized === 'string' && !normalized.includes(':')) {
      return encrypt(normalized);
    }
    return value;
  },
  get(value) {
    if (!value) return value;
    return decrypt(value);
  },
};

const deliveryAddressSchema = new mongoose.Schema(
  {
    label: { type: String, default: 'Primary' },
    address: { type: String, required: true },
    city: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    phone: { type: String, default: '' },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true }
);

const b2bBuyerSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    companyName: { type: String, required: true, trim: true },
    tradingName: { type: String, default: '', trim: true },
    vatNumber: { type: String, default: '', trim: true },
    contactFirstName: { type: String, required: true, trim: true },
    contactLastName: { type: String, required: true, trim: true },
    email: encryptedString,
    phone: { type: String, default: '' },
    passwordHash: { type: String, required: true, select: false },
    tierId: { type: mongoose.Schema.Types.ObjectId, ref: 'B2BTier', required: true },
    status: {
      type: String,
      enum: ['pending', 'approved', 'suspended', 'rejected'],
      default: 'pending',
      index: true,
    },
    paymentTerms: {
      type: String,
      enum: ['prepaid', 'net30', 'on_account'],
      default: 'prepaid',
    },
    canOrder: { type: Boolean, default: true },
    deliveryAddresses: [deliveryAddressSchema],
    notifications: {
      orderUpdates: { type: Boolean, default: true },
      promotions: { type: Boolean, default: false },
    },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TeamMember', default: null },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', default: null },
    internalNotes: { type: String, default: '' },
    lastLoginAt: { type: Date, default: null },
    failedLoginAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    preferredWarehouseId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Warehouse',
      default: null,
    },
    allowedWarehouseIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse' }],
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

b2bBuyerSchema.index({ clientID: 1, email: 1 }, { unique: true });

b2bBuyerSchema.set('toJSON', {
  getters: true,
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

module.exports = mongoose.model('B2BBuyer', b2bBuyerSchema);
