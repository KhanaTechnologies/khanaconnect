const mongoose = require('mongoose');

const emailSubscriberSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        validate: {
            validator: function(v) {
                return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
            },
            message: props => `${props.value} is not a valid email address!`
        }
    },
    name: { type: String, default: '' },
    clientID: { type: String, required: true }, // Reference to the client
    dateSubscribed: {
        type: Date,
        default: Date.now
    },
    isActive: {
        type: Boolean,
        default: true
    }
});

emailSubscriberSchema.index({ email: 1, clientID: 1 }, { unique: true });

module.exports = mongoose.model('EmailSubscriber', emailSubscriberSchema);
