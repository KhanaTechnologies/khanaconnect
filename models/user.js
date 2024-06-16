const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const userSchema = new Schema({
    userType: { type: String, enum: ['client', 'customer'], required: true },
    clientID: { type: String, required: true }, // Reference to the client
    // Client fields
    companyName: { type: String },
    merchant_id: { type: Number, unique: true },
    merchant_key: { type: String, unique: true },
    passphrase: { type: String, unique: true },
    password: { type: String },
    token: { type: String, unique: true },
    return_url: { type: String },
    businessEmail: { type: String, unique: true },
    businessEmailPassword: { type: String },
    // Customer fields
    customerFirstName: { type: String },
    customerLastName: { type: String },
    emailAddress: { type: String, unique: true },
    phoneNumber: { type: Number, unique: true },
    passwordHash: { type: String },
    street: { type: String, default: '' },
    apartment: { type: String, default: '' },
    city: { type: String, default: '' },
    postalCode: { type: String, default: '' },
    isVerified: { type: Boolean, default: false },
}, { timestamps: true });

userSchema.virtual('id').get(function () { return this._id.toHexString(); });
userSchema.set('toJSON', { virtuals: true });

const User = mongoose.model('User', userSchema);

module.exports = User;
