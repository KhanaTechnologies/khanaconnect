const mongoose = require('mongoose');

const emailSubscriberSchema = new mongoose.Schema({
    email: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        lowercase: true,
        validate: {
            validator: function(v) {
                return /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/.test(v);
            },
            message: props => `${props.value} is not a valid email address!`
        }
    },
    firstName: { type: String, required: true }, // Changed "Name" to "name" to follow naming convention
    clientID: { type: String, required: true }, // Reference to the client
    dateSubscribed: {
        type: Date,
        default: Date.now
    },
    isActive: {
        type: Boolean,
        default: false
    }
});

module.exports = mongoose.model('EmailSubscriber', emailSubscriberSchema);
