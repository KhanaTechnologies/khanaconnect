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
// POST: Create a new booking
router.post('/', validateClient, wrapRoute(async (req, res) => {
    const clientId = req.clientId;
    const client = await Client.findOne({ clientID: clientId });
    
    if (!client) {
        return res.status(404).json({ error: 'Client not found' });
    }

    // ... all your existing validation and booking creation code ...
    
    const booking = new Booking(bookingData);
    await booking.save();
    
    // Populate the response
    const populatedBooking = await Booking.findById(booking._id)
        .populate('assignedTo')
        .populate('resourceId');
    
    // SEND RESPONSE IMMEDIATELY - DON'T WAIT FOR EMAILS
    res.status(201).json({
        message: 'Booking created successfully',
        booking: populatedBooking,
        reminderSchedule: {
            type: bookingType === 'accommodation' ? '24 hours before check-in/out' : 
                  (new Date(booking.date).toDateString() === new Date().toDateString() ? '2 hours before' : '24 hours before'),
            scheduledTime: booking.reminders[0]?.scheduledTime
        }
    });

    // ============ BACKGROUND EMAIL PROCESSING ============
    // Process confirmation email after response is sent
    setImmediate(async () => {
        try {
            const hasValidEmail = client.businessEmail && 
                                 client.businessEmailPassword && 
                                 !client.businessEmail.includes('company.com') &&
                                 client.businessEmail !== 'your-email@gmail.com';
            
            if (hasValidEmail) {
                if (bookingType === 'accommodation') {
                    await sendAccommodationConfirmationEmail(
                        populatedBooking, 
                        client.businessEmail, 
                        client.businessEmailPassword, 
                        client.clientName || clientId
                    );
                } else if (bookingType === 'mixed') {
                    await sendMixedBookingConfirmationEmail(
                        populatedBooking, 
                        client.businessEmail, 
                        client.businessEmailPassword, 
                        client.clientName || clientId
                    );
                } else {
                    await sendBookingConfirmationEmail(
                        populatedBooking, 
                        client.businessEmail, 
                        client.businessEmailPassword, 
                        client.clientName || clientId
                    );
                }
                console.log('✅ Background confirmation email sent successfully');
            } else {
                console.log('📧 [DEV MODE] Confirmation email would be sent to:', booking.customerEmail);
            }
        } catch (emailError) {
            console.error('⚠️ Background email failed:', emailError.message);
        }
    });
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

    // Don't allow updating accommodation bookings to service or mixed
    if (booking.bookingType === 'accommodation' && req.body.bookingType && req.body.bookingType !== 'accommodation') {
        return res.status(400).json({ error: 'Cannot change accommodation booking to service booking' });
    }

    // Validate resource if provided
    if (req.body.resourceId) {
        let resourceId = req.body.resourceId;
        if (typeof req.body.resourceId === 'object' && req.body.resourceId._id) {
            resourceId = req.body.resourceId._id;
        }
        
        if (!mongoose.Types.ObjectId.isValid(resourceId)) {
            return res.status(400).json({ error: 'Invalid resource ID format' });
        }
        const resource = await Resource.findOne({ _id: resourceId, clientID: clientId });
        if (!resource) {
            return res.status(400).json({ error: 'Resource not found or does not belong to your client' });
        }
        req.body.resourceId = resourceId;
    }

    // Handle assignedTo - frontend sends full staff object or just ID
    if (req.body.assignedTo) {
        let staffId = req.body.assignedTo;
        if (typeof req.body.assignedTo === 'object' && req.body.assignedTo._id) {
            staffId = req.body.assignedTo._id;
        }
        
        if (staffId) {
            if (!mongoose.Types.ObjectId.isValid(staffId)) {
                return res.status(400).json({ error: 'Invalid staff ID format' });
            }
            const staff = await Staff.findOne({ _id: staffId, clientID: clientId });
            if (!staff) {
                return res.status(400).json({ error: 'Staff member not found or does not belong to your client' });
            }
            req.body.assignedTo = staffId;
        }
    } else if (req.body.assignedTo === '' || req.body.assignedTo === 'unassigned' || req.body.assignedTo === null) {
        req.body.assignedTo = null;
    }

    // Validate duration if provided
    if (req.body.duration) {
        const duration = parseInt(req.body.duration);
        if (isNaN(duration) || duration <= 0) {
            return res.status(400).json({ error: 'Duration must be a positive number' });
        }
        req.body.duration = duration;
    }

    // Update fields
    const updatableFields = [
        'customerName', 'customerEmail', 'customerPhone', 'services',
        'date', 'time', 'duration', 'assignedTo', 'resourceId', 
        'notes', 'status', 'endTime'
    ];

    // Handle accommodation-specific updates
    if (booking.bookingType === 'accommodation' || booking.bookingType === 'mixed') {
        if (req.body.accommodation) {
            if (req.body.accommodation.checkIn || req.body.accommodation.checkOut) {
                const checkIn = new Date(req.body.accommodation.checkIn || booking.accommodation.checkIn);
                const checkOut = new Date(req.body.accommodation.checkOut || booking.accommodation.checkOut);
                
                if (checkIn >= checkOut) {
                    return res.status(400).json({ error: 'Check-out date must be after check-in date' });
                }
                
                booking.accommodation = {
                    ...booking.accommodation,
                    ...req.body.accommodation
                };
                
                const numberOfNights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
                booking.accommodation.numberOfNights = numberOfNights;
                
                booking.reminders = [
                    {
                        type: 'email',
                        scheduledTime: new Date(checkIn.getTime() - 24 * 60 * 60 * 1000),
                        sent: false,
                        reminderType: 'checkin'
                    },
                    {
                        type: 'email',
                        scheduledTime: new Date(checkOut.getTime() - 24 * 60 * 60 * 1000),
                        sent: false,
                        reminderType: 'checkout'
                    }
                ];
            }
        }
    }

    // For service bookings, recalculate endTime and reminders if date/time/duration changes
    if (booking.bookingType === 'service' || booking.bookingType === 'mixed') {
        const dateChanged = req.body.date && req.body.date !== booking.date.toISOString().split('T')[0];
        const timeChanged = req.body.time && req.body.time !== booking.time;
        const durationChanged = req.body.duration && req.body.duration !== booking.duration;
        
        if (dateChanged || timeChanged || durationChanged) {
            const bookingDate = req.body.date || booking.date;
            const bookingTime = req.body.time || booking.time;
            const bookingDuration = parseInt(req.body.duration) || booking.duration;
            
            if (bookingTime) {
                const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
                if (!timeRegex.test(bookingTime)) {
                    return res.status(400).json({ error: 'Invalid time format. Use HH:MM format (e.g., 09:15, 14:30, 16:45)' });
                }
            }
            
            if (!req.body.endTime) {
                const [hours, minutes] = bookingTime.split(':').map(Number);
                const startDateTime = new Date(bookingDate);
                startDateTime.setHours(hours, minutes, 0, 0);
                const endDateTime = new Date(startDateTime.getTime() + bookingDuration * 60000);
                req.body.endTime = `${endDateTime.getHours().toString().padStart(2, '0')}:${endDateTime.getMinutes().toString().padStart(2, '0')}`;
            }
            
            booking.duration = bookingDuration;
            
            const now = new Date();
            const appointmentDate = new Date(bookingDate);
            const [hours, minutes] = bookingTime.split(':').map(Number);
            appointmentDate.setHours(hours, minutes, 0, 0);
            
            let reminderTime;
            const isToday = appointmentDate.toDateString() === now.toDateString();
            
            if (isToday) {
                reminderTime = new Date(appointmentDate.getTime() - 2 * 60 * 60 * 1000);
                console.log(`📅 Booking moved to today - scheduling reminder 2 hours before at: ${reminderTime.toISOString()}`);
            } else {
                reminderTime = new Date(appointmentDate.getTime() - 24 * 60 * 60 * 1000);
                console.log(`📅 Future booking - scheduling reminder 24 hours before at: ${reminderTime.toISOString()}`);
            }
            
            if (reminderTime < now) {
                console.log(`⚠️ Calculated reminder time is in the past (${reminderTime.toISOString()}), setting to now + 1 minute`);
                reminderTime = new Date(now.getTime() + 60 * 1000);
            }
            
            booking.reminders = [{
                type: 'email',
                scheduledTime: reminderTime,
                sent: false,
                reminderType: 'service'
            }];
        }
    }

    // Update all updatable fields
    updatableFields.forEach(field => {
        if (req.body[field] !== undefined) {
            booking[field] = req.body[field];
        }
    });

    // If endTime wasn't set but we have duration and time, calculate it
    if (!booking.endTime && booking.time && booking.duration) {
        const [hours, minutes] = booking.time.split(':').map(Number);
        const startDateTime = new Date(booking.date);
        startDateTime.setHours(hours, minutes, 0, 0);
        const endDateTime = new Date(startDateTime.getTime() + booking.duration * 60000);
        booking.endTime = `${endDateTime.getHours().toString().padStart(2, '0')}:${endDateTime.getMinutes().toString().padStart(2, '0')}`;
    }

    await booking.save();
    
    // Populate the response
    const updatedBooking = await Booking.findById(booking._id)
        .populate('assignedTo')
        .populate('resourceId');
    
    // ============ ASYNC EMAIL SENDING - NON BLOCKING ============
    // Send response immediately, then handle emails in the background
    
    res.json({
        message: 'Booking updated successfully',
        booking: updatedBooking
    });

    // ============ BACKGROUND EMAIL PROCESSING ============
    // This runs AFTER the response is sent, so frontend doesn't wait
    
    // Check if this is a service booking that was moved to today
    if (booking.bookingType === 'service' && req.body.date) {
        const newDate = new Date(req.body.date);
        const today = new Date();
        const isToday = newDate.toDateString() === today.toDateString();
        
        if (isToday) {
            // Process email in background without blocking
            setImmediate(async () => {
                try {
                    // Check if client has valid email configuration
                    const hasValidEmail = client.businessEmail && 
                                         client.businessEmailPassword && 
                                         !client.businessEmail.includes('company.com') &&
                                         client.businessEmail !== 'your-email@gmail.com';
                    
                    if (hasValidEmail) {
                        const [hours, minutes] = booking.time.split(':').map(Number);
                        const appointmentTime = new Date(booking.date);
                        appointmentTime.setHours(hours, minutes, 0, 0);
                        
                        const hoursUntilAppointment = (appointmentTime.getTime() - today.getTime()) / (1000 * 60 * 60);
                        
                        // Only send immediate notification if appointment is within 2 hours
                        if (hoursUntilAppointment <= 2 && hoursUntilAppointment > 0) {
                            console.log(`📧 Sending background notification for today's rescheduled booking ${booking._id}`);
                            await sendBookingConfirmationEmail(
                                booking,
                                client.businessEmail,
                                client.businessEmailPassword,
                                client.clientName || booking.clientID
                            );
                            console.log(`✅ Background notification sent for booking ${booking._id}`);
                        }
                    }
                } catch (emailError) {
                    console.error(`⚠️ Background email failed for booking ${booking._id}:`, emailError.message);
                    // Never throw - this is background processing
                }
            });
        }
    }
    
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

// Utility function to calculate end time - updated to handle any minute value
function calculateEndTime(startTime, duration) {
    if (!startTime) return null;
    
    const [hours, minutes] = startTime.split(':').map(Number);
    const startDateTime = new Date();
    startDateTime.setHours(hours, minutes, 0, 0);
    const endDateTime = new Date(startDateTime.getTime() + parseInt(duration) * 60000);
    return `${endDateTime.getHours().toString().padStart(2, '0')}:${endDateTime.getMinutes().toString().padStart(2, '0')}`;
}

// Utility function to generate time slots with support for 15-minute intervals
function generateTimeSlots(date, existingBookings, duration = 60) {
    const slots = [];
    const startHour = 9; // 9 AM
    const endHour = 17; // 5 PM
    const intervalMinutes = 15; // Changed from 30 to 15 for more granular slots
    
    for (let hour = startHour; hour < endHour; hour++) {
        for (let minute = 0; minute < 60; minute += intervalMinutes) {
            const slotTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
            const slotEnd = new Date(date);
            slotEnd.setHours(hour, minute + parseInt(duration), 0, 0);
            
            // Check if slot goes beyond end hour
            if (slotEnd.getHours() > endHour || (slotEnd.getHours() === endHour && slotEnd.getMinutes() > 0)) {
                continue;
            }
            
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
                    duration: parseInt(duration),
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