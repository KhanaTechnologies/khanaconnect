const mongoose = require('mongoose');

const bookingSchema = new mongoose.Schema({
    customerName: {
        type: String,
        required: true,
        trim: true,
    },
    customerEmail: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
    },
    customerPhone: {
        type: String,
        required: true,
        trim: true,
    },
    services: {
        type: [String],
        required: true,
    },
    date: {
        type: Date,
        required: true,
    },
    time: {
        type: String,
        required: true,
    },
    endTime: {
        type: String,
        required: true,
    },
    duration: {
        type: Number,
    },
    assignedTo: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Staff",
        default: null,
    },
    resourceId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Resource",
        default: null,
    },
    notes: {
        type: String,
        trim: true,
    },
    status: {
        type: String,
        enum: ['pending', 'confirmed', 'scheduled', 'completed', 'cancelled', 'no-show'],
        default: 'pending'
    },
    clientID: {
        type: String,
        required: true,
    },
    payment: {
        amount: Number,
        currency: { type: String, default: 'ZAR' },
        status: { type: String, enum: ['pending', 'paid', 'refunded', 'failed'], default: 'pending' },
        paymentMethod: String,
        transactionId: String,
        paidAt: Date
    },
    reminders: [{
        type: { type: String, enum: ['email', 'sms'], required: true },
        scheduledTime: Date,
        sent: { type: Boolean, default: false },
        sentAt: Date
    }],
    calendarEventId: String,
    recurring: {
        pattern: { type: String, enum: ['weekly', 'bi-weekly', 'monthly'] },
        endDate: Date,
        parentBooking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' }
    }
}, { timestamps: true });

// Indexes for better performance
bookingSchema.index({ clientID: 1, date: 1 });
bookingSchema.index({ clientID: 1, status: 1 });
bookingSchema.index({ clientID: 1, 'payment.status': 1 });

module.exports = mongoose.model("Booking", bookingSchema);