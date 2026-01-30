const mongoose = require('mongoose');

const waitlistSchema = new mongoose.Schema({
    clientID: { 
        type: String, 
        required: true 
    },
    customerName: { 
        type: String, 
        required: true 
    },
    customerEmail: { 
        type: String, 
        required: true 
    },
    customerPhone: { 
        type: String, 
        required: true 
    },
    services: [String],
    preferredDates: [Date],
    preferredTimes: [String],
    status: { 
        type: String, 
        enum: ['active', 'notified', 'booked', 'cancelled'], 
        default: 'active' 
    },
    priority: {
        type: Number,
        default: 1,
        min: 1,
        max: 5
    },
    notes: {
        type: String,
        trim: true
    },
    convertedToBooking: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Booking'
    },
    lastNotified: Date,
    notificationCount: {
        type: Number,
        default: 0
    },
    expirationDate: {
        type: Date,
        default: function() {
            return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from creation
        }
    }
}, { 
    timestamps: true 
});

// Indexes
waitlistSchema.index({ clientID: 1, status: 1 });
waitlistSchema.index({ clientID: 1, expirationDate: 1 });
waitlistSchema.index({ clientID: 1, services: 1 });
waitlistSchema.index({ expirationDate: 1 }, { expireAfterSeconds: 0 }); // Auto-delete expired entries

module.exports = mongoose.model("Waitlist", waitlistSchema);