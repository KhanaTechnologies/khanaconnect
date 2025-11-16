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
        enum: ['room', 'equipment', 'station', 'vehicle', 'table', 'chair', 'bed', 'court', 'field', 'other'],
        default: 'room'
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
    isActive: {
        type: Boolean,
        default: true,
    },
    clientID: {
        type: String,
        required: true,
    },
    features: [String],
    location: {
        type: String,
        trim: true,
    },
    color: {
        type: String,
        default: '#3B82F6'
    },
    defaultDuration: {
        type: Number, // Default duration in minutes
        default: 60,
        min: 15,
        max: 480
    },
    breakBetweenBookings: {
        type: Number, // Cleaning/prep time between bookings in minutes
        default: 15,
        min: 0,
        max: 120
    },
    operatingHours: {
        Monday: { start: String, end: String, closed: Boolean },
        Tuesday: { start: String, end: String, closed: Boolean },
        Wednesday: { start: String, end: String, closed: Boolean },
        Thursday: { start: String, end: String, closed: Boolean },
        Friday: { start: String, end: String, closed: Boolean },
        Saturday: { start: String, end: String, closed: Boolean },
        Sunday: { start: String, end: String, closed: Boolean }
    },
    maintenanceSchedule: [{
        start: Date,
        end: Date,
        reason: String,
        recurring: Boolean
    }],
    costPerHour: {
        type: Number,
        default: 0
    },
    images: [String],
    specifications: mongoose.Schema.Types.Mixed, // Flexible field for specific resource details
    tags: [String]
}, { timestamps: true });

// Indexes
resourceSchema.index({ clientID: 1, isActive: 1 });
resourceSchema.index({ clientID: 1, type: 1 });
resourceSchema.index({ clientID: 1, tags: 1 });

// Virtual for checking if resource is available at a given time
resourceSchema.methods.isAvailable = async function(date, startTime, duration) {
    const startDateTime = new Date(`${date}T${startTime}`);
    const endDateTime = new Date(startDateTime.getTime() + duration * 60000);
    
    // Check maintenance
    const duringMaintenance = this.maintenanceSchedule.some(maintenance => {
        return startDateTime < maintenance.end && endDateTime > maintenance.start;
    });
    
    if (duringMaintenance) return false;
    
    // Check operating hours
    const dayOfWeek = startDateTime.toLocaleDateString('en-US', { weekday: 'long' });
    const operatingHour = this.operatingHours[dayOfWeek];
    
    if (operatingHour && operatingHour.closed) return false;
    
    if (operatingHour && operatingHour.start && operatingHour.end) {
        const [openHour, openMinute] = operatingHour.start.split(':').map(Number);
        const [closeHour, closeMinute] = operatingHour.end.split(':').map(Number);
        
        const openTime = new Date(startDateTime);
        openTime.setHours(openHour, openMinute, 0, 0);
        
        const closeTime = new Date(startDateTime);
        closeTime.setHours(closeHour, closeMinute, 0, 0);
        
        if (startDateTime < openTime || endDateTime > closeTime) return false;
    }
    
    // Check existing bookings
    const conflictingBooking = await mongoose.model('Booking').findOne({
        resourceId: this._id,
        date: date,
        status: { $in: ['scheduled', 'confirmed'] },
        $or: [
            { 
                time: { $lt: startTime },
                endTime: { $gt: startTime }
            },
            {
                time: { $lt: endDateTime.toTimeString().slice(0, 5) },
                endTime: { $gt: endDateTime.toTimeString().slice(0, 5) }
            },
            {
                time: { $gte: startTime },
                endTime: { $lte: endDateTime.toTimeString().slice(0, 5) }
            }
        ]
    });
    
    return !conflictingBooking;
};

module.exports = mongoose.model("Resource", resourceSchema);