const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Booking = require('../models/booking');
const Waitlist = require('../models/waitlist');
const Staff = require('../models/staff');
const Resource = require('../models/resource'); // Add this line
const { wrapRoute } = require('../helpers/failureEmail');
const Client = require('../models/client');
const {
    sendBookingConfirmationEmail,
    sendBookingReminderEmail,
    sendPaymentConfirmationEmail,
    sendBookingCancellationEmail
} = require('../utils/email');

// Middleware to authenticate JWT and attach clientId
const validateClient = (req, res, next) => {
    const token = req.headers.authorization;
    if (!token || !token.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized - Token missing or invalid format' });

    const tokenValue = token.split(' ')[1];
    jwt.verify(tokenValue, process.env.secret, (err, user) => {
        if (err || !user.clientID) return res.status(403).json({ error: 'Forbidden - Invalid token' });
        req.clientId = user.clientID;
        next();
    });
};

// GET: Get all bookings with filters
router.get('/', validateClient, wrapRoute(async (req, res) => {
    const clientId = req.clientId;
    const client = await Client.findOne({ clientID: req.clientId });
    const { date, status, assignedTo, startDate, endDate } = req.query;
    
    let filter = { clientID: clientId };
    
    if (date) filter.date = new Date(date);
    if (status) filter.status = status;
    if (assignedTo) filter.assignedTo = assignedTo;
    if (startDate && endDate) {
        filter.date = {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        };
    }
    
    const bookings = await Booking.find(filter)
        .populate('assignedTo')
        .populate('resourceId') // This will work now that Resource model is imported
        .sort({ date: 1, time: 1 });
    
    res.json(bookings);
}));

// POST: Create a new booking (supports both services and accommodation)
router.post('/', validateClient, wrapRoute(async (req, res) => {
    const clientId = req.clientId;
    const client = await Client.findOne({ clientID: clientId });
    
    if (!client) {
        return res.status(404).json({ error: 'Client not found' });
    }

    if (!req.body) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    const bookingType = req.body.bookingType || 'service';
    
    // Validate based on booking type
    if (bookingType === 'accommodation' || bookingType === 'mixed') {
        if (!req.body.accommodation || !req.body.accommodation.checkIn || !req.body.accommodation.checkOut) {
            return res.status(400).json({ error: 'Check-in and check-out dates are required for accommodation bookings' });
        }
        
        const checkIn = new Date(req.body.accommodation.checkIn);
        const checkOut = new Date(req.body.accommodation.checkOut);
        
        if (checkIn >= checkOut) {
            return res.status(400).json({ error: 'Check-out date must be after check-in date' });
        }
        
        // Validate same-day booking permissions for accommodation
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        checkIn.setHours(0, 0, 0, 0);
        
        if (checkIn.getTime() === today.getTime() && client.tier !== 'gold') {
            return res.status(400).json({ 
                error: 'Same-day accommodation bookings are only available for Gold tier clients.' 
            });
        }
    }

    // Validate resource/room if provided
    if (req.body.resourceId) {
        if (!mongoose.Types.ObjectId.isValid(req.body.resourceId)) {
            return res.status(400).json({ error: 'Invalid resource ID format' });
        }
        const resource = await Resource.findOne({ _id: req.body.resourceId, clientID: clientId });
        if (!resource) {
            return res.status(400).json({ error: 'Resource not found or does not belong to your client' });
        }
    }

    // Calculate end time for service bookings
    let endTime = req.body.endTime;
    if (!endTime && req.body.duration && bookingType !== 'accommodation') {
        const [hours, minutes] = req.body.time.split(':').map(Number);
        const startDateTime = new Date(req.body.date);
        startDateTime.setHours(hours, minutes, 0, 0);
        const endDateTime = new Date(startDateTime.getTime() + req.body.duration * 60000);
        endTime = `${endDateTime.getHours().toString().padStart(2, '0')}:${endDateTime.getMinutes().toString().padStart(2, '0')}`;
    }

    // Calculate reminder times
    const reminders = [];
    const now = new Date();

    if (bookingType === 'accommodation' || bookingType === 'mixed') {
        // Accommodation reminders
        const checkInDate = new Date(req.body.accommodation.checkIn);
        const checkOutDate = new Date(req.body.accommodation.checkOut);
        
        // Check-in reminder (24 hours before)
        reminders.push({
            type: 'email',
            scheduledTime: new Date(checkInDate.getTime() - 24 * 60 * 60 * 1000),
            sent: false,
            reminderType: 'checkin'
        });
        
        // Check-out reminder (day before check-out)
        reminders.push({
            type: 'email',
            scheduledTime: new Date(checkOutDate.getTime() - 24 * 60 * 60 * 1000),
            sent: false,
            reminderType: 'checkout'
        });
        
    } else {
        // Service booking reminder
        const appointmentDate = new Date(req.body.date);
        const [hours, minutes] = req.body.time.split(':').map(Number);
        appointmentDate.setHours(hours, minutes, 0, 0);

        let reminderTime;
        if (appointmentDate.toDateString() === now.toDateString() && client.tier === 'gold') {
            reminderTime = new Date(now.getTime() + 60 * 60 * 1000);
        } else {
            reminderTime = new Date(appointmentDate.getTime() - 24 * 60 * 60 * 1000);
        }

        reminders.push({
            type: 'email',
            scheduledTime: reminderTime,
            sent: false,
            reminderType: 'service'
        });
    }

    const bookingData = {
        customerName: req.body.customerName,
        customerEmail: req.body.customerEmail,
        customerPhone: req.body.customerPhone,
        services: req.body.services,
        date: req.body.date,
        time: req.body.time,
        endTime: endTime,
        duration: req.body.duration,
        assignedTo: req.body.assignedTo,
        resourceId: req.body.resourceId,
        notes: req.body.notes,
        clientID: clientId,
        status: req.body.status || "confirmed",
        bookingType: bookingType,
        reminders: reminders,
        payment: {
            amount: req.body.amount,
            currency: 'ZAR',
            status: req.body.amount ? 'pending' : 'paid'
        }
    };

    // Add accommodation data if provided
    if (bookingType === 'accommodation' || bookingType === 'mixed') {
        bookingData.accommodation = {
            checkIn: req.body.accommodation.checkIn,
            checkOut: req.body.accommodation.checkOut,
            numberOfGuests: req.body.accommodation.numberOfGuests || 1,
            numberOfRooms: req.body.accommodation.numberOfRooms || 1,
            roomType: req.body.accommodation.roomType || 'double',
            specialRequests: req.body.accommodation.specialRequests,
            amenities: req.body.accommodation.amenities || []
        };
        
        // Calculate number of nights
        const checkIn = new Date(req.body.accommodation.checkIn);
        const checkOut = new Date(req.body.accommodation.checkOut);
        const numberOfNights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
        bookingData.accommodation.numberOfNights = numberOfNights;
        
        // Calculate payment details for accommodation
        if (req.body.amount) {
            bookingData.payment.depositAmount = req.body.accommodation.depositAmount || (req.body.amount * 0.5); // 50% deposit
            bookingData.payment.balanceDue = req.body.amount - bookingData.payment.depositAmount;
            bookingData.payment.dueDate = new Date(checkIn.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days before check-in
        }
    }

    // Add guest info if provided
    if (req.body.guestInfo) {
        bookingData.guestInfo = req.body.guestInfo;
    }

    const booking = new Booking(bookingData);
    await booking.save();
    
    // Send appropriate confirmation email
    try {
        if (bookingType === 'accommodation') {
            await sendAccommodationConfirmationEmail(booking, client.businessEmail, client.businessEmailPassword, client.clientName || clientId);
        } else if (bookingType === 'mixed') {
            await sendMixedBookingConfirmationEmail(booking, client.businessEmail, client.businessEmailPassword, client.clientName || clientId);
        } else {
            await sendBookingConfirmationEmail(booking, client.businessEmail, client.businessEmailPassword, client.clientName || clientId);
        }
        console.log('Confirmation email sent successfully');
    } catch (emailError) {
        console.error('Failed to send confirmation email:', emailError);
    }
    
    res.status(201).json(booking);
}));

// PUT: Update a booking by ID
router.put('/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;
    const client = await Client.findOne({ clientID: req.clientId });
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid booking ID format' });
    }

    const booking = await Booking.findOne({ _id: id, clientID: clientId });
    if (!booking) {
        return res.status(404).json({ error: 'Booking not found or unauthorized' });
    }

    // Validate resource if provided
    if (req.body.resourceId) {
        if (!mongoose.Types.ObjectId.isValid(req.body.resourceId)) {
            return res.status(400).json({ error: 'Invalid resource ID format' });
        }
        const resource = await Resource.findOne({ _id: req.body.resourceId, clientID: clientId });
        if (!resource) {
            return res.status(400).json({ error: 'Resource not found or does not belong to your client' });
        }
    }

    // Update fields
    const updatableFields = [
        'customerName', 'customerEmail', 'customerPhone', 'services',
        'date', 'time', 'endTime', 'duration', 'assignedTo', 'resourceId', 
        'notes', 'status'
    ];

    updatableFields.forEach(field => {
        if (req.body[field] !== undefined) {
            booking[field] = req.body[field];
        }
    });

    await booking.save();
    res.json(booking);
}));

// POST: Payment Confirmation Webhook
router.post('/:id/payment-confirmation', wrapRoute(async (req, res) => {
    const { id } = req.params;
    const { transactionId, amount, paymentMethod, status } = req.body;

    const booking = await Booking.findById(id);
    if (!booking) {
        return res.status(404).json({ error: 'Booking not found' });
    }

    // Get client for email
    const client = await Client.findOne({ clientID: booking.clientID });

    // Update payment details
    booking.payment = {
        amount: amount,
        status: status,
        paymentMethod: paymentMethod,
        transactionId: transactionId,
        paidAt: status === 'paid' ? new Date() : null
    };

    // Update booking status based on payment
    if (status === 'paid') {
        booking.status = 'confirmed';
        
        // Send payment confirmation email
        try {
            await sendPaymentConfirmationEmail(booking, client.businessEmail, client.businessEmailPassword, client.clientName || booking.clientID);
        } catch (emailError) {
            console.error('Failed to send payment confirmation email:', emailError);
        }
    }

    await booking.save();
    res.json({ message: 'Payment status updated', booking });
}));

// GET: Check availability
router.get('/availability/check', validateClient, wrapRoute(async (req, res) => {
    const { date, duration, resourceId } = req.query;
    const clientId = req.clientId;
    
    if (!date) {
        return res.status(400).json({ error: 'Date is required' });
    }

    const targetDate = new Date(date);
    const existingBookings = await Booking.find({
        clientID: clientId,
        date: targetDate,
        resourceId: resourceId || { $exists: false },
        status: { $in: ['scheduled', 'confirmed'] }
    });

    // Generate available time slots
    const availableSlots = generateTimeSlots(targetDate, existingBookings, duration);
    
    res.json({ availableSlots, date: targetDate.toISOString().split('T')[0] });
}));

// POST: Add to waitlist
router.post('/waitlist', validateClient, wrapRoute(async (req, res) => {
    const clientId = req.clientId;
    const { customerName, customerEmail, customerPhone, services, preferredDates, preferredTimes } = req.body;

    const waitlistEntry = new Waitlist({
        clientID: clientId,
        customerName,
        customerEmail,
        customerPhone,
        services,
        preferredDates: preferredDates.map(date => new Date(date)),
        preferredTimes,
        status: 'active'
    });

    await waitlistEntry.save();
    res.status(201).json(waitlistEntry);
}));

// DELETE: Cancel booking
router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;
    const client = await Client.findOne({ clientID: req.clientId });
    const { reason } = req.body;

    const booking = await Booking.findOne({ _id: id, clientID: clientId });
    if (!booking) {
        return res.status(404).json({ error: 'Booking not found or unauthorized' });
    }

    // Send cancellation email
    try {
        await sendBookingCancellationEmail(booking, client.businessEmail, client.businessEmailPassword, client.clientName || clientId, reason);
    } catch (emailError) {
        console.error('Failed to send cancellation email:', emailError);
    }

    // Process waitlist if this was a desirable time slot
    if (booking.status === 'confirmed') {
        await processWaitlist(booking);
    }

    booking.status = 'cancelled';
    await booking.save();

    res.json({ message: 'Booking cancelled successfully' });
}));

// GET: Get available resources
router.get('/resources/available', validateClient, wrapRoute(async (req, res) => {
    const clientId = req.clientId;
    const { date, time, duration } = req.query;
    
    if (!date || !time) {
        return res.status(400).json({ error: 'Date and time are required' });
    }

    const targetDate = new Date(date);
    const bookingDuration = duration || 60; // Default 60 minutes
    
    // Get all active resources for this client
    const allResources = await Resource.find({ 
        clientID: clientId, 
        isActive: true 
    });

    // Get bookings that conflict with the requested time
    const conflictingBookings = await Booking.find({
        clientID: clientId,
        date: targetDate,
        status: { $in: ['scheduled', 'confirmed'] },
        $or: [
            // Booking starts during requested slot
            { 
                time: { $lt: time },
                endTime: { $gt: time }
            },
            // Booking ends during requested slot  
            {
                time: { $lt: calculateEndTime(time, bookingDuration) },
                endTime: { $gt: calculateEndTime(time, bookingDuration) }
            },
            // Booking completely contains requested slot
            {
                time: { $lte: time },
                endTime: { $gte: calculateEndTime(time, bookingDuration) }
            }
        ]
    });

    // Filter out resources that are booked
    const bookedResourceIds = conflictingBookings.map(booking => booking.resourceId?.toString()).filter(id => id);
    const availableResources = allResources.filter(resource => 
        !bookedResourceIds.includes(resource._id.toString())
    );

    res.json({
        availableResources,
        totalResources: allResources.length,
        bookedResources: bookedResourceIds.length
    });
}));

// Utility function to calculate end time
function calculateEndTime(startTime, duration) {
    const [hours, minutes] = startTime.split(':').map(Number);
    const startDateTime = new Date();
    startDateTime.setHours(hours, minutes, 0, 0);
    const endDateTime = new Date(startDateTime.getTime() + duration * 60000);
    return `${endDateTime.getHours().toString().padStart(2, '0')}:${endDateTime.getMinutes().toString().padStart(2, '0')}`;
}

// Utility function to generate time slots
function generateTimeSlots(date, existingBookings, duration = 60) {
    const slots = [];
    const startHour = 9; // 9 AM
    const endHour = 17; // 5 PM
    
    for (let hour = startHour; hour < endHour; hour++) {
        for (let minute = 0; minute < 60; minute += 30) { // 30-minute intervals
            const slotTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            const slotEnd = new Date(date);
            slotEnd.setHours(hour, minute + duration, 0, 0);
            const slotEndTime = `${slotEnd.getHours().toString().padStart(2, '0')}:${slotEnd.getMinutes().toString().padStart(2, '0')}`;
            
            // Check if slot conflicts with existing bookings
            const isAvailable = !existingBookings.some(booking => {
                return (slotTime >= booking.time && slotTime < booking.endTime) ||
                       (slotEndTime > booking.time && slotEndTime <= booking.endTime) ||
                       (slotTime <= booking.time && slotEndTime >= booking.endTime);
            });
            
            if (isAvailable) {
                slots.push({
                    time: slotTime,
                    endTime: slotEndTime,
                    available: true
                });
            }
        }
    }
    
    return slots;
}

// Utility function to process waitlist
async function processWaitlist(cancelledBooking) {
    const waitlistEntries = await Waitlist.find({
        clientID: cancelledBooking.clientID,
        services: { $in: cancelledBooking.services },
        status: 'active',
        $or: [
            { preferredDates: { $size: 0 } },
            { preferredDates: cancelledBooking.date }
        ]
    }).sort({ createdAt: 1 });

    for (const entry of waitlistEntries) {
        // Notify customer about availability
        // You would implement actual notification logic here
        console.log(`Notifying waitlist entry ${entry._id} about available slot`);
        
        entry.status = 'notified';
        await entry.save();
        break; // Only notify the first matching entry
    }
}

// GET: Get all waitlist entries for client
router.get('/waitlist', validateClient, wrapRoute(async (req, res) => {
    const clientId = req.clientId;
    const { status, service } = req.query;
    
    let filter = { clientID: clientId };
    
    if (status) filter.status = status;
    if (service) filter.services = { $in: [service] };
    
    const waitlistEntries = await Waitlist.find(filter)
        .sort({ createdAt: 1 });
    
    res.json({
        entries: waitlistEntries,
        total: waitlistEntries.length,
        active: waitlistEntries.filter(entry => entry.status === 'active').length,
        notified: waitlistEntries.filter(entry => entry.status === 'notified').length
    });
}));

// GET: Get specific waitlist entry
router.get('/waitlist/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid waitlist ID format' });
    }

    const waitlistEntry = await Waitlist.findOne({ _id: id, clientID: clientId });
    if (!waitlistEntry) {
        return res.status(404).json({ error: 'Waitlist entry not found or unauthorized' });
    }

    res.json(waitlistEntry);
}));

// PUT: Update waitlist entry status
router.put('/waitlist/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;
    const { status, notes } = req.body;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid waitlist ID format' });
    }

    const waitlistEntry = await Waitlist.findOne({ _id: id, clientID: clientId });
    if (!waitlistEntry) {
        return res.status(404).json({ error: 'Waitlist entry not found or unauthorized' });
    }

    if (status && ['active', 'notified', 'booked', 'cancelled'].includes(status)) {
        waitlistEntry.status = status;
    }
    
    if (notes !== undefined) {
        waitlistEntry.notes = notes;
    }

    await waitlistEntry.save();
    res.json(waitlistEntry);
}));

// DELETE: Remove from waitlist
router.delete('/waitlist/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid waitlist ID format' });
    }

    const waitlistEntry = await Waitlist.findOneAndDelete({ _id: id, clientID: clientId });
    if (!waitlistEntry) {
        return res.status(404).json({ error: 'Waitlist entry not found or unauthorized' });
    }

    res.json({ message: 'Waitlist entry removed successfully' });
}));

// POST: Convert waitlist entry to booking
router.post('/waitlist/:id/convert-to-booking', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;
    const client = await Client.findOne({ clientID: clientId });
    const { date, time, duration, assignedTo, resourceId, notes } = req.body;
    
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid waitlist ID format' });
    }

    const waitlistEntry = await Waitlist.findOne({ _id: id, clientID: clientId });
    if (!waitlistEntry) {
        return res.status(404).json({ error: 'Waitlist entry not found or unauthorized' });
    }

    if (!date || !time) {
        return res.status(400).json({ error: 'Date and time are required to convert to booking' });
    }

    // Calculate end time
    let endTime = req.body.endTime;
    if (!endTime && duration) {
        const [hours, minutes] = time.split(':').map(Number);
        const startDateTime = new Date();
        startDateTime.setHours(hours, minutes, 0, 0);
        const endDateTime = new Date(startDateTime.getTime() + duration * 60000);
        endTime = `${endDateTime.getHours().toString().padStart(2, '0')}:${endDateTime.getMinutes().toString().padStart(2, '0')}`;
    }

    // Create booking from waitlist entry
    const booking = new Booking({
        customerName: waitlistEntry.customerName,
        customerEmail: waitlistEntry.customerEmail,
        customerPhone: waitlistEntry.customerPhone,
        services: waitlistEntry.services,
        date: date,
        time: time,
        endTime: endTime,
        duration: duration,
        assignedTo: assignedTo,
        resourceId: resourceId,
        notes: notes || `Converted from waitlist. Original preferences: ${waitlistEntry.preferredDates.join(', ')}`,
        clientID: clientId,
        status: "confirmed",
        payment: {
            amount: req.body.amount || 0,
            status: req.body.amount ? 'pending' : 'paid'
        },
         reminders: [{
        type: 'email',
        scheduledTime: new Date(new Date(req.body.date).getTime() - 24 * 60 * 60 * 1000),
        sent: false
    }]
    });

    await booking.save();
    
    // Update waitlist entry status
    waitlistEntry.status = 'booked';
    waitlistEntry.convertedToBooking = booking._id;
    await waitlistEntry.save();
    
    // Send confirmation email
    try {
        await sendBookingConfirmationEmail(booking, client.businessEmail, client.businessEmailPassword, client.clientName || clientId);
    } catch (emailError) {
        console.error('Failed to send confirmation email:', emailError);
    }

    res.json({
        message: 'Waitlist entry successfully converted to booking',
        booking: booking,
        waitlistEntry: waitlistEntry
    });
}));

// Enhanced availability check in routes/booking.js
router.get('/availability/advanced-check', validateClient, wrapRoute(async (req, res) => {
    const { date, duration, resourceType, services, partySize } = req.query;
    const clientId = req.clientId;
    
    if (!date) {
        return res.status(400).json({ error: 'Date is required' });
    }

    const targetDate = new Date(date);
    const bookingDuration = duration ? parseInt(duration) : 60;
    
    // Get all resources that match criteria
    let resourceFilter = { 
        clientID: clientId, 
        isActive: true 
    };
    
    if (resourceType) resourceFilter.type = resourceType;
    if (partySize) resourceFilter.capacity = { $gte: parseInt(partySize) };
    
    const allResources = await Resource.find(resourceFilter);
    
    // Check availability for each resource
    const availabilityResults = await Promise.all(
        allResources.map(async (resource) => {
            const availableSlots = await generateResourceTimeSlots(targetDate, resource, bookingDuration);
            return {
                resource: {
                    _id: resource._id,
                    name: resource.name,
                    type: resource.type,
                    capacity: resource.capacity,
                    features: resource.features,
                    location: resource.location
                },
                availableSlots,
                totalSlots: availableSlots.length
            };
        })
    );
    
    // Filter out resources with no available slots
    const availableResources = availabilityResults.filter(result => result.availableSlots.length > 0);
    
    res.json({
        date: targetDate.toISOString().split('T')[0],
        duration: bookingDuration,
        availableResources,
        totalResources: allResources.length,
        availableCount: availableResources.length
    });
}));

// Enhanced time slot generation
async function generateResourceTimeSlots(date, resource, duration) {
    const slots = [];
    const dayOfWeek = date.toLocaleDateString('en-US', { weekday: 'long' });
    const operatingHours = resource.operatingHours[dayOfWeek];
    
    // Skip if closed
    if (operatingHours && operatingHours.closed) return slots;
    
    // Determine time range
    const startHour = operatingHours && operatingHours.start ? 
        parseInt(operatingHours.start.split(':')[0]) : 9;
    const endHour = operatingHours && operatingHours.end ? 
        parseInt(operatingHours.end.split(':')[0]) : 17;
    
    // Get existing bookings for this resource
    const existingBookings = await Booking.find({
        resourceId: resource._id,
        date: date,
        status: { $in: ['scheduled', 'confirmed'] }
    });
    
    // Generate slots
    for (let hour = startHour; hour < endHour; hour++) {
        for (let minute = 0; minute < 60; minute += 30) {
            const slotTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            const slotEnd = new Date(date);
            slotEnd.setHours(hour, minute + duration + resource.breakBetweenBookings, 0, 0);
            const slotEndTime = `${slotEnd.getHours().toString().padStart(2, '0')}:${slotEnd.getMinutes().toString().padStart(2, '0')}`;
            
            // Check if slot is available
            const isAvailable = await resource.isAvailable(
                date.toISOString().split('T')[0], 
                slotTime, 
                duration
            );
            
            if (isAvailable) {
                slots.push({
                    time: slotTime,
                    endTime: slotEndTime,
                    duration: duration,
                    cost: resource.costPerHour ? (resource.costPerHour * duration / 60) : 0
                });
            }
        }
    }
    
    return slots;
}




// Add this to your booking routes
router.get('/debug/all-bookings', validateClient, wrapRoute(async (req, res) => {
    const now = new Date();
    const fortyEightHoursFromNow = new Date(now.getTime() + 48 * 60 * 60 * 1000);
    
    console.log('=== DEBUG: Checking ALL bookings in system ===');
    console.log('Current time:', now.toISOString());
    console.log('Search range:', fortyEightHoursFromNow.toISOString());
    
    const allBookings = await Booking.find({
        clientID: req.clientId,
        $or: [
            { date: { $gte: now } },
            { 'accommodation.checkIn': { $gte: now } }
        ]
    }).sort({ date: 1 });
    
    console.log(`Total future bookings found: ${allBookings.length}`);
    
    const debugBookings = allBookings.map(booking => {
        const bookingDate = new Date(booking.date);
        const [hours, minutes] = booking.time ? booking.time.split(':').map(Number) : [0, 0];
        bookingDate.setHours(hours, minutes, 0, 0);
        
        const hoursUntil = booking.time ? 
            ((bookingDate.getTime() - now.getTime()) / (1000 * 60 * 60)).toFixed(1) : 
            'N/A';
            
        return {
            id: booking._id.toString(),
            customer: booking.customerName,
            type: booking.bookingType,
            date: booking.date,
            time: booking.time,
            status: booking.status,
            checkIn: booking.accommodation?.checkIn,
            checkOut: booking.accommodation?.checkOut,
            hoursUntil: hoursUntil,
            reminders: booking.reminders ? booking.reminders.length : 0,
            sentReminders: booking.reminders ? booking.reminders.filter(r => r.sent).length : 0
        };
    });
    
    console.log('All future bookings:', JSON.stringify(debugBookings, null, 2));
    
    res.json({
        currentTime: now.toISOString(),
        bookings: debugBookings,
        total: allBookings.length
    });
}));

module.exports = router;