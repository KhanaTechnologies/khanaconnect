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
        required: function() {
            return this.bookingType !== 'accommodation';
        }
    },
    endTime: {
        type: String,
        required: function() {
            return this.bookingType !== 'accommodation';
        }
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
        enum: ['pending', 'confirmed', 'scheduled', 'completed', 'cancelled', 'no-show', 'checked-in', 'checked-out'],
        default: 'pending'
    },
    clientID: {
        type: String,
        required: true,
    },
    
    // ========================
    // GUEST HOUSE SPECIFIC FIELDS
    // ========================
    bookingType: {
        type: String,
        enum: ['service', 'accommodation', 'mixed'],
        default: 'service',
        required: true
    },
    
    // Accommodation Details
    accommodation: {
        checkIn: {
            type: Date,
            required: function() { return this.bookingType === 'accommodation' || this.bookingType === 'mixed'; }
        },
        checkOut: {
            type: Date,
            required: function() { return this.bookingType === 'accommodation' || this.bookingType === 'mixed'; }
        },
        numberOfNights: {
            type: Number,
            default: 1
        },
        numberOfGuests: {
            type: Number,
            default: 1,
            min: 1
        },
        numberOfRooms: {
            type: Number,
            default: 1,
            min: 1
        },
        roomType: {
            type: String,
            enum: ['single', 'double', 'suite', 'family', 'deluxe'],
            default: 'double'
        },
        specialRequests: {
            type: String,
            trim: true
        },
        amenities: [{
            type: String
        }]
    },
    
    // Guest Information
    guestInfo: {
        idNumber: String,
        address: String,
        emergencyContact: {
            name: String,
            phone: String,
            relationship: String
        },
        vehicleRegistration: String,
        nationality: String
    },
    
    payment: {
        amount: Number,
        currency: { type: String, default: 'ZAR' },
        status: { type: String, enum: ['pending', 'paid', 'refunded', 'failed', 'deposit-paid'], default: 'pending' },
        paymentMethod: String,
        transactionId: String,
        paidAt: Date,
        depositAmount: Number,
        balanceDue: Number,
        dueDate: Date
    },
    
    reminders: [{
        type: { type: String, enum: ['email', 'sms'], required: true },
        scheduledTime: Date,
        sent: { type: Boolean, default: false },
        sentAt: Date,
        reminderType: String // 'checkin', 'checkout', 'service', 'payment'
    }],
    
    calendarEventId: String,
    
    recurring: {
        pattern: { type: String, enum: ['weekly', 'bi-weekly', 'monthly'] },
        endDate: Date,
        parentBooking: { type: mongoose.Schema.Types.ObjectId, ref: 'Booking' }
    }
}, { timestamps: true });

// Virtual for calculating total nights
bookingSchema.virtual('totalNights').get(function() {
    if (this.accommodation.checkIn && this.accommodation.checkOut) {
        const diffTime = Math.abs(this.accommodation.checkOut - this.accommodation.checkIn);
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }
    return 0;
});

// Indexes for better performance
bookingSchema.index({ clientID: 1, date: 1 });
bookingSchema.index({ clientID: 1, status: 1 });
bookingSchema.index({ clientID: 1, 'payment.status': 1 });
bookingSchema.index({ clientID: 1, 'accommodation.checkIn': 1 });
bookingSchema.index({ clientID: 1, 'accommodation.checkOut': 1 });
bookingSchema.index({ clientID: 1, bookingType: 1 });

module.exports = mongoose.model("Booking", bookingSchema);