const mongoose = require('mongoose');

const resourceSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true,
    },
    type: {
        type: String,
        required: true,
        enum: ['room', 'treatment-room', 'meeting-room', 'facility', 'equipment', 'vehicle', 'court', 'field', 'other'],
        default: 'room'
    },
    // Room-specific fields
    roomType: {
        type: String,
        enum: ['single', 'double', 'suite', 'family', 'deluxe', 'executive', 'dormitory'],
        required: function() { return this.type === 'room'; }
    },
    description: {
        type: String,
        trim: true,
    },
    capacity: {
        type: Number,
        default: 1,
        min: 1
    },
    // Pricing
    basePrice: {
        type: Number,
        default: 0
    },
    costPerHour: {
        type: Number,
        default: 0
    },
    // Room amenities
    amenities: [{
        type: String
    }],
    features: [{
        type: String
    }],
    images: [{
        type: String
    }],
    // Availability management
    isActive: {
        type: Boolean,
        default: true,
    },
    clientID: {
        type: String,
        required: true,
    },
    location: {
        type: String,
        trim: true,
    },
    color: {
        type: String,
        default: '#3B82F6'
    },
    // Scheduling settings
    defaultDuration: {
        type: Number, // Default duration in minutes
        default: 60,
        min: 15,
        max: 1440
    },
    breakBetweenBookings: {
        type: Number, // Cleaning/prep time between bookings in minutes
        default: 30, // Increased for accommodation
        min: 0,
        max: 240
    },
    // Operating hours
    operatingHours: {
        type: Map,
        of: {
            start: String, // "09:00"
            end: String,   // "17:00"
            closed: { type: Boolean, default: false }
        },
        default: () => new Map()
    },
    // Maintenance scheduling
    maintenanceSchedule: [{
        start: Date,
        end: Date,
        reason: String,
        recurring: Boolean
    }],
    // Flexible specifications
    specifications: mongoose.Schema.Types.Mixed,
    tags: [String]
}, { timestamps: true });

// Indexes
resourceSchema.index({ clientID: 1, isActive: 1 });
resourceSchema.index({ clientID: 1, type: 1 });
resourceSchema.index({ clientID: 1, roomType: 1 });
resourceSchema.index({ clientID: 1, tags: 1 });

// Virtual for checking if resource is available at a given time
resourceSchema.methods.isAvailable = async function(date, startTime, duration) {
    const startDateTime = new Date(`${date}T${startTime}`);
    const endDateTime = new Date(startDateTime.getTime() + duration * 60000);
    
    // Check if resource is active
    if (!this.isActive) return false;
    
    // Check maintenance schedule
    const duringMaintenance = this.maintenanceSchedule.some(maintenance => {
        return startDateTime < maintenance.end && endDateTime > maintenance.start;
    });
    
    if (duringMaintenance) return false;
    
    // Check operating hours
    const dayOfWeek = startDateTime.toLocaleDateString('en-US', { weekday: 'long' });
    const operatingHour = this.operatingHours.get(dayOfWeek);
    
    if (operatingHour && operatingHour.closed) return false;
    
    if (operatingHour && operatingHour.start && operatingHour.end) {
        const [openHour, openMinute] = operatingHour.start.split(':').map(Number);
        const [closeHour, closeMinute] = operatingHour.end.split(':').map(Number);
        
        const openTime = new Date(startDateTime);
        openTime.setHours(openHour, openMinute, 0, 0);
        
        const closeTime = new Date(startDateTime);
        closeTime.setHours(closeHour, closeMinute, 0, 0);
        
        if (startDateTime < openTime || endDateTime > closeTime) {
            return false;
        }
    }
    
    // Check existing bookings
    const Booking = mongoose.model('Booking');
    const conflictingBookings = await Booking.find({
        resourceId: this._id,
        status: { $in: ['scheduled', 'confirmed', 'checked-in'] },
        $or: [
            // Booking overlaps with start of requested time
            {
                $or: [
                    { date: { $lte: startDateTime } },
                    { 'accommodation.checkIn': { $lte: startDateTime } }
                ],
                $or: [
                    { endTime: { $gt: startDateTime } },
                    { 'accommodation.checkOut': { $gt: startDateTime } }
                ]
            },
            // Booking overlaps with end of requested time
            {
                $or: [
                    { date: { $lt: endDateTime } },
                    { 'accommodation.checkIn': { $lt: endDateTime } }
                ],
                $or: [
                    { endTime: { $gte: endDateTime } },
                    { 'accommodation.checkOut': { $gte: endDateTime } }
                ]
            },
            // Requested time completely contains a booking
            {
                $or: [
                    { date: { $gte: startDateTime } },
                    { 'accommodation.checkIn': { $gte: startDateTime } }
                ],
                $or: [
                    { endTime: { $lte: endDateTime } },
                    { 'accommodation.checkOut': { $lte: endDateTime } }
                ]
            }
        ]
    });
    
    return conflictingBookings.length === 0;
};

// Method to get room rate for specific dates
resourceSchema.methods.calculateRate = function(checkIn, checkOut, numberOfGuests = 1) {
    if (this.type !== 'room') return this.costPerHour;
    
    const checkInDate = new Date(checkIn);
    const checkOutDate = new Date(checkOut);
    const numberOfNights = Math.ceil((checkOutDate - checkInDate) / (1000 * 60 * 60 * 24));
    
    let rate = this.basePrice * numberOfNights;
    
    // Additional charges for extra guests if capacity is exceeded
    if (numberOfGuests > this.capacity) {
        const extraGuests = numberOfGuests - this.capacity;
        rate += (extraGuests * 100 * numberOfNights); // R100 per extra guest per night
    }
    
    return rate;
};

module.exports = mongoose.model("Resource", resourceSchema);