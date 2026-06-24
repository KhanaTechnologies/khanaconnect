const mongoose = require('mongoose');
const { encrypt, decrypt } = require('../helpers/encryption');

const encryptedString = {
  type: String,
  set(value) {
    if (!value) return value;
    if (typeof value === 'string' && !value.includes(':')) {
      return encrypt(value.trim().toLowerCase());
    }
    return value;
  },
  get(value) {
    if (!value) return value;
    return decrypt(value);
  },
};

const permissionSchema = {
  bookings: { type: Boolean, default: false },
  orders: { type: Boolean, default: false },
  staff: { type: Boolean, default: false },
  categories: { type: Boolean, default: false },
  preorder: { type: Boolean, default: false },
  voting: { type: Boolean, default: false },
  sales: { type: Boolean, default: false },
  services: { type: Boolean, default: false },
  products: { type: Boolean, default: false },
  dashboard: { type: Boolean, default: true },
};

const teamMemberSchema = new mongoose.Schema(
  {
    clientID: { type: String, required: true, index: true },
    email: encryptedString,
    firstName: { type: String, trim: true, default: '' },
    lastName: { type: String, trim: true, default: '' },
    passwordHash: { type: String, required: true, select: false },
    orgRole: {
      type: String,
      enum: ['owner', 'admin', 'manager', 'member'],
      default: 'member',
    },
    permissions: permissionSchema,
    status: {
      type: String,
      enum: ['invited', 'active', 'disabled'],
      default: 'active',
    },
    invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'TeamMember', default: null },
    lastLoginAt: { type: Date, default: null },
    resetPasswordToken: { type: String, select: false, default: null },
    resetPasswordExpires: { type: Date, default: null },
    inviteToken: { type: String, select: false, default: null },
    inviteExpires: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: { getters: true },
    toObject: { getters: true },
  }
);

teamMemberSchema.index({ resetPasswordToken: 1 }, { sparse: true });
teamMemberSchema.index({ inviteToken: 1 }, { sparse: true });

teamMemberSchema.virtual('displayName').get(function displayName() {
  const name = `${this.firstName || ''} ${this.lastName || ''}`.trim();
  return name || this.email;
});

teamMemberSchema.set('toJSON', {
  virtuals: true,
  getters: true,
  transform(_doc, ret) {
    delete ret.passwordHash;
    return ret;
  },
});

teamMemberSchema.set('toObject', { virtuals: true, getters: true });

module.exports = mongoose.model('TeamMember', teamMemberSchema);
