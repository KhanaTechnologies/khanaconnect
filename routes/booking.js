const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const Booking = require('../models/booking');
const Waitlist = require('../models/waitlist');
const Staff = require('../models/staff');
const Resource = require('../models/resource'); // Add this line
const { wrapRoute } = require('../helpers/failureEmail');
const { bookingPaymentWebhookOk } = require('../helpers/webhookAuth');
const Client = require('../models/client');
const {
    sendBookingConfirmationEmail,
    sendBookingReminderEmail,
    sendPaymentConfirmationEmail,
    sendBookingCancellationEmail,
    sendAccommodationConfirmationEmail,
    sendMixedBookingConfirmationEmail,
    sendBookingUpdateNotificationEmail,
    sendBookingEmailReassignedNotice,
    sendBookingStatementEmail,
} = require('../utils/email');
const { diffBookingForCustomer, normalizeCustomerNotifyChanges } = require('../utils/bookingEmailHelpers');
const { clientEmailBrandingPayload } = require('../helpers/clientEmailBranding');
const WhatsAppService = require('../services/saas/WhatsAppService');
const { verifyJwtWithAnySecret } = require('../helpers/jwtSecret');
const { createDashboardAuth } = require('../helpers/dashboardAuth');
const { recordTeamActivityFromRequest } = require('../helpers/teamActivity');
const { autoAdvancePastBookings } = require('../helpers/bookingStatus');
const {
  assertNoConflicts,
  resolveDayHours,
  buffersForServices,
  timeToMinutes,
} = require('../helpers/bookingConflicts');
const Service = require('../models/service');
const crypto = require('crypto');

const validateClient = createDashboardAuth('bookings');

function clientCanSendMail(client) {
    return Boolean(
        client &&
        client.businessEmail &&
        client.businessEmailPassword &&
        !String(client.businessEmail).includes('company.com') &&
        client.businessEmail !== 'your-email@gmail.com'
    );
}

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

    await autoAdvancePastBookings({ clientID: clientId });
    
    const bookings = await Booking.find(filter)
        .populate('assignedTo')
        .populate('resourceId') // This will work now that Resource model is imported
        .sort({ date: 1, time: 1 });
    
    res.json(bookings);
}));

// POST: Create a new booking (service, accommodation, or mixed)
router.post('/', validateClient, wrapRoute(async (req, res) => {
    const clientId = req.clientId;
    const client = await Client.findOne({ clientID: clientId });

    if (!client) {
        return res.status(404).json({ error: 'Client not found' });
    }

    const bookingType = req.body.bookingType || 'service';
    const {
        customerName,
        customerEmail,
        customerPhone,
        services,
        date,
        time,
        duration,
        assignedTo,
        resourceId,
        notes,
        accommodation,
        payment,
        guestInfo,
        status,
    } = req.body;

    if (!customerName || !customerEmail || !customerPhone) {
        return res.status(400).json({ error: 'customerName, customerEmail, and customerPhone are required' });
    }

    let servicesList = Array.isArray(services) ? services : services ? [services] : [];
    if (bookingType === 'accommodation' && servicesList.length === 0) {
        servicesList = ['Accommodation'];
    }
    if (servicesList.length === 0) {
        return res.status(400).json({ error: 'At least one service (or accommodation) is required' });
    }

    let assignedToId = null;
    if (assignedTo) {
        let staffId = assignedTo;
        if (typeof assignedTo === 'object' && assignedTo._id) staffId = assignedTo._id;
        if (!mongoose.Types.ObjectId.isValid(staffId)) {
            return res.status(400).json({ error: 'Invalid staff ID format' });
        }
        const staff = await Staff.findOne({ _id: staffId, clientID: clientId });
        if (!staff) {
            return res.status(400).json({ error: 'Staff member not found or does not belong to your client' });
        }
        assignedToId = staffId;
    }

    let resourceObjectId = null;
    if (resourceId) {
        let rid = resourceId;
        if (typeof resourceId === 'object' && resourceId._id) rid = resourceId._id;
        if (!mongoose.Types.ObjectId.isValid(rid)) {
            return res.status(400).json({ error: 'Invalid resource ID format' });
        }
        const resource = await Resource.findOne({ _id: rid, clientID: clientId });
        if (!resource) {
            return res.status(400).json({ error: 'Resource not found or does not belong to your client' });
        }
        resourceObjectId = rid;
    }

    let bookingDate;
    let bookingTime;
    let bookingDuration;
    let endTime = req.body.endTime;
    let reminders = [];

    if (bookingType === 'accommodation' || bookingType === 'mixed') {
        if (!accommodation?.checkIn || !accommodation?.checkOut) {
            return res.status(400).json({ error: 'accommodation.checkIn and accommodation.checkOut are required' });
        }
        const checkIn = new Date(accommodation.checkIn);
        const checkOut = new Date(accommodation.checkOut);
        if (checkIn >= checkOut) {
            return res.status(400).json({ error: 'Check-out must be after check-in' });
        }
        bookingDate = checkIn;
        reminders.push(
            {
                type: 'email',
                scheduledTime: new Date(checkIn.getTime() - 24 * 60 * 60 * 1000),
                sent: false,
                reminderType: 'checkin',
            },
            {
                type: 'email',
                scheduledTime: new Date(checkOut.getTime() - 24 * 60 * 60 * 1000),
                sent: false,
                reminderType: 'checkout',
            }
        );
    }

    if (bookingType === 'service' || bookingType === 'mixed') {
        if (!date || !time || !duration) {
            return res.status(400).json({ error: 'date, time, and duration are required for service bookings' });
        }
        const timeRegex = /^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/;
        if (!timeRegex.test(time)) {
            return res.status(400).json({ error: 'Invalid time format. Use HH:MM' });
        }
        bookingDate = new Date(date);
        bookingTime = time;
        bookingDuration = parseInt(duration, 10);
        if (Number.isNaN(bookingDuration) || bookingDuration <= 0) {
            return res.status(400).json({ error: 'duration must be a positive number (minutes)' });
        }
        if (!endTime) {
            const [hours, minutes] = bookingTime.split(':').map(Number);
            const startDateTime = new Date(bookingDate);
            startDateTime.setHours(hours, minutes, 0, 0);
            const endDateTime = new Date(startDateTime.getTime() + bookingDuration * 60000);
            endTime = `${endDateTime.getHours().toString().padStart(2, '0')}:${endDateTime.getMinutes().toString().padStart(2, '0')}`;
        }
        const appointmentDate = new Date(bookingDate);
        const [h, m] = bookingTime.split(':').map(Number);
        appointmentDate.setHours(h, m, 0, 0);
        const now = new Date();
        const isToday = appointmentDate.toDateString() === now.toDateString();
        let reminderTime = isToday
            ? new Date(appointmentDate.getTime() - 2 * 60 * 60 * 1000)
            : new Date(appointmentDate.getTime() - 24 * 60 * 60 * 1000);
        if (reminderTime < now) {
            reminderTime = new Date(now.getTime() + 60 * 1000);
        }
        reminders.push({
            type: 'email',
            scheduledTime: reminderTime,
            sent: false,
            reminderType: 'service',
        });
    }

    // Conflict check for service bookings (staff / resource).
    // Soft by default so existing merchant double-book workflows keep working.
    // Pass strictConflicts: true (body) to reject overlaps.
    let conflictWarning = null;
    if ((bookingType === 'service' || bookingType === 'mixed') && (assignedToId || resourceObjectId)) {
      const buffers = await buffersForServices(clientId, servicesList);
      try {
        await assertNoConflicts({
          clientId,
          date: bookingDate,
          time: bookingTime,
          endTime,
          durationMin: bookingDuration || buffers.duration,
          assignedTo: assignedToId,
          resourceId: resourceObjectId,
          bufferBeforeMin: buffers.before,
          bufferAfterMin: buffers.after,
        });
      } catch (conflictErr) {
        if (req.body.strictConflicts === true || req.body.strictConflicts === 'true') {
          return res.status(conflictErr.status || 409).json({
            error: conflictErr.message,
            conflicts: conflictErr.conflicts || [],
          });
        }
        conflictWarning = {
          message: conflictErr.message,
          conflicts: conflictErr.conflicts || [],
        };
        console.warn(`[bookings] overlap allowed (soft) client=${clientId}: ${conflictErr.message}`);
      }
    }

    const accPayload =
        bookingType === 'accommodation' || bookingType === 'mixed'
            ? {
                  checkIn: new Date(accommodation.checkIn),
                  checkOut: new Date(accommodation.checkOut),
                  numberOfNights: Math.ceil(
                      (new Date(accommodation.checkOut) - new Date(accommodation.checkIn)) / (1000 * 60 * 60 * 24)
                  ),
                  numberOfGuests: accommodation.numberOfGuests || 1,
                  numberOfRooms: accommodation.numberOfRooms || 1,
                  roomType: accommodation.roomType || 'double',
                  specialRequests: accommodation.specialRequests || '',
                  amenities: accommodation.amenities || [],
              }
            : undefined;

    const bookingData = {
        customerName,
        customerEmail: String(customerEmail).toLowerCase().trim(),
        customerPhone,
        services: servicesList,
        date: bookingDate,
        time: bookingType === 'accommodation' ? undefined : bookingTime,
        endTime: bookingType === 'accommodation' ? undefined : endTime,
        duration: bookingType === 'accommodation' ? undefined : bookingDuration,
        assignedTo: assignedToId,
        resourceId: resourceObjectId,
        notes: notes || '',
        clientID: clientId,
        bookingType,
        status: status || 'pending',
        payment: payment || { status: 'pending' },
        guestInfo: guestInfo || {},
        reminders,
        accommodation: accPayload,
    };

    const booking = new Booking(bookingData);
    await booking.save();

    const populatedBooking = await Booking.findById(booking._id).populate('assignedTo').populate('resourceId');

    res.status(201).json({
        message: 'Booking created successfully',
        booking: populatedBooking,
        ...(conflictWarning ? { conflictWarning } : {}),
        reminderSchedule: {
            type:
                bookingType === 'accommodation'
                    ? '24 hours before check-in/out'
                    : new Date(booking.date).toDateString() === new Date().toDateString()
                      ? '2 hours before'
                      : '24 hours before',
            scheduledTime: booking.reminders[0]?.scheduledTime,
        },
    });
    recordTeamActivityFromRequest(req, {
      category: 'bookings',
      action: 'booking.created',
      summary: `Booking created for ${booking.customerName || 'customer'}`,
      metadata: { bookingId: String(booking._id) },
    });

    const displayName = client.companyName || client.clientName || clientId;
    const emailSig = client.emailSignature || '';
    const emailBranding = clientEmailBrandingPayload(client);

    setImmediate(async () => {
        try {
            const hasValidEmail =
                client.businessEmail &&
                client.businessEmailPassword &&
                !String(client.businessEmail).includes('company.com') &&
                client.businessEmail !== 'your-email@gmail.com';

            if (hasValidEmail) {
                if (bookingType === 'accommodation') {
                    await sendAccommodationConfirmationEmail(
                        populatedBooking,
                        client.businessEmail,
                        client.businessEmailPassword,
                        displayName,
                        emailSig,
                        emailBranding
                    );
                } else if (bookingType === 'mixed') {
                    await sendMixedBookingConfirmationEmail(
                        populatedBooking,
                        client.businessEmail,
                        client.businessEmailPassword,
                        displayName,
                        emailSig,
                        emailBranding
                    );
                } else {
                    await sendBookingConfirmationEmail(
                        populatedBooking,
                        client.businessEmail,
                        client.businessEmailPassword,
                        displayName,
                        emailSig,
                        emailBranding
                    );
                }
                console.log('✅ Background confirmation email sent successfully');

                WhatsAppService.safeNotifyBookingConfirmation({
                    clientId: booking.clientID || client.clientID,
                    to: booking.customerPhone || populatedBooking.customerPhone,
                    companyName: displayName || client.companyName,
                    bookingRef: String(booking._id || populatedBooking._id),
                    when: WhatsAppService.formatBookingWhen(populatedBooking || booking),
                }).catch(() => {});
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

    const previousSnapshot = booking.toObject();

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

    const notifyCustomer =
        req.query.notifyCustomer !== 'false' &&
        req.body.notifyCustomer !== false &&
        req.body.notifyCustomer !== 'false';

    const rawNotifyChanges = req.body.customerNotifyChanges ?? req.body.notifyCustomerChanges;
    let changeRows;
    if (Array.isArray(rawNotifyChanges)) {
        changeRows = normalizeCustomerNotifyChanges(rawNotifyChanges);
    } else {
        changeRows = diffBookingForCustomer(previousSnapshot, updatedBooking.toObject());
    }
    const customerNotifyReason =
        typeof req.body.customerNotifyReason === 'string' ? req.body.customerNotifyReason.trim() : '';
    const emailSig = client.emailSignature || '';
    const emailBranding = clientEmailBrandingPayload(client);
    
    // ============ ASYNC EMAIL SENDING - NON BLOCKING ============
    // Send response immediately, then handle emails in the background
    
    res.json({
        message: 'Booking updated successfully',
        booking: updatedBooking
    });
    recordTeamActivityFromRequest(req, {
      category: 'bookings',
      action: 'booking.updated',
      summary: `Booking ${updatedBooking._id} updated`,
      metadata: { bookingId: String(updatedBooking._id) },
    });

    // ============ BACKGROUND EMAIL PROCESSING ============
    // This runs AFTER the response is sent, so frontend doesn't wait

    if (notifyCustomer && changeRows.length > 0 && clientCanSendMail(client)) {
        const displayName = client.clientName || client.companyName || clientId;
        const prevEmailRaw = (previousSnapshot.customerEmail || '').trim();
        const newEmailRaw = (updatedBooking.customerEmail || '').trim();
        const prevNorm = prevEmailRaw.toLowerCase();
        const newNorm = newEmailRaw.toLowerCase();
        setImmediate(async () => {
            try {
                if (prevNorm && newNorm && prevNorm !== newNorm) {
                    await sendBookingEmailReassignedNotice(
                        prevEmailRaw,
                        updatedBooking,
                        client.businessEmail,
                        client.businessEmailPassword,
                        displayName,
                        emailSig,
                        emailBranding
                    );
                    const gapMs = Math.max(0, parseInt(String(process.env.SMTP_BETWEEN_MESSAGES_MS || '450'), 10) || 450);
                    if (gapMs > 0 && newEmailRaw) await new Promise((r) => setTimeout(r, gapMs));
                }
                if (newEmailRaw) {
                    await sendBookingUpdateNotificationEmail(
                        updatedBooking,
                        changeRows,
                        client.businessEmail,
                        client.businessEmailPassword,
                        displayName,
                        { reason: customerNotifyReason, toEmail: newEmailRaw, emailSignature: emailSig, branding: emailBranding }
                    );
                }
            } catch (emailError) {
                console.error('⚠️ Booking update notification email failed:', emailError.message);
            }
        });
    }
    
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
                    if (clientCanSendMail(client)) {
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
                                client.clientName || booking.clientID,
                                client.emailSignature || '',
                                clientEmailBrandingPayload(client)
                            );
                            console.log(`✅ Background notification sent for booking ${booking._id}`);

                            WhatsAppService.safeNotifyBookingConfirmation({
                                clientId: booking.clientID || client.clientID,
                                to: booking.customerPhone,
                                companyName: client.companyName || client.clientName || booking.clientID,
                                bookingRef: String(booking._id),
                                when: WhatsAppService.formatBookingWhen(booking),
                            }).catch(() => {});
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

// POST: Email customer a booking/payment record (for their records — not a payment request)
router.post('/:id/send-statement', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;

    if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid booking ID format' });
    }

    const booking = await Booking.findOne({ _id: id, clientID: clientId });
    if (!booking) {
        return res.status(404).json({ error: 'Booking not found or unauthorized' });
    }

    if (!booking.customerEmail) {
        return res.status(400).json({ error: 'Booking has no customer email' });
    }

    const client = await Client.findOne({ clientID: clientId });
    if (!client) {
        return res.status(404).json({ error: 'Client not found' });
    }

    if (!clientCanSendMail(client)) {
        return res.status(503).json({ error: 'Business email is not configured for sending' });
    }

    const displayName = client.clientName || client.companyName || clientId;
    await sendBookingStatementEmail(
        booking,
        client.businessEmail,
        client.businessEmailPassword,
        displayName,
        client.emailSignature || '',
        clientEmailBrandingPayload(client)
    );

    res.json({
        ok: true,
        message: 'Statement email sent',
        to: booking.customerEmail,
    });
}));

// POST: Payment confirmation (webhook auth only when BOOKING_PAYMENT_WEBHOOK_ENABLED=true)
router.post('/:id/payment-confirmation', wrapRoute(async (req, res) => {
    if (!bookingPaymentWebhookOk(req)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

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
            await sendPaymentConfirmationEmail(
                booking,
                client.businessEmail,
                client.businessEmailPassword,
                client.clientName || booking.clientID,
                client.emailSignature || '',
                clientEmailBrandingPayload(client)
            );
        } catch (emailError) {
            console.error('Failed to send payment confirmation email:', emailError);
        }
    }

    await booking.save();
    res.json({ message: 'Payment status updated', booking });
}));

// GET: Check availability
router.get('/availability/check', validateClient, wrapRoute(async (req, res) => {
    const { date, duration, resourceId, assignedTo, services } = req.query;
    const clientId = req.clientId;

    if (!date) {
        return res.status(400).json({ error: 'Date is required' });
    }

    const targetDate = new Date(date);
    const serviceNames = services
      ? String(services).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const buffers = await buffersForServices(clientId, serviceNames);
    const bookingDuration = duration ? parseInt(duration, 10) : buffers.duration;

    let resource = null;
    if (resourceId) {
      resource = await Resource.findOne({ _id: resourceId, clientID: clientId });
    }
    const hours = await resolveDayHours({
      clientId,
      date: targetDate,
      assignedTo: assignedTo || null,
      resource,
    });

    const existingBookings = await Booking.find({
        clientID: clientId,
        date: {
          $gte: new Date(new Date(targetDate).setHours(0, 0, 0, 0)),
          $lte: new Date(new Date(targetDate).setHours(23, 59, 59, 999)),
        },
        ...(resourceId ? { resourceId } : {}),
        ...(assignedTo ? { assignedTo } : {}),
        status: { $nin: ['cancelled', 'no-show'] },
    });

    const availableSlots = await generateTimeSlots(
      targetDate,
      existingBookings,
      bookingDuration,
      hours,
      buffers
    );

    res.json({
      availableSlots,
      date: targetDate.toISOString().split('T')[0],
      hours,
      duration: bookingDuration,
    });
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

// DELETE: Permanently remove booking (Cancel status is via PUT / status change)
router.delete('/:id', validateClient, wrapRoute(async (req, res) => {
    const { id } = req.params;
    const clientId = req.clientId;
    const client = await Client.findOne({ clientID: req.clientId });
    const reason =
      (req.body && req.body.reason) ||
      (typeof req.query.reason === 'string' ? req.query.reason : '') ||
      'Removed by dashboard user';

    const booking = await Booking.findOne({ _id: id, clientID: clientId });
    if (!booking) {
        return res.status(404).json({ error: 'Booking not found or unauthorized' });
    }

    // Best-effort customer notice before the row is removed
    if (client && booking.status !== 'cancelled') {
        try {
            await sendBookingCancellationEmail(
                booking,
                client.businessEmail,
                client.businessEmailPassword,
                client.clientName || clientId,
                reason,
                client.emailSignature || '',
                clientEmailBrandingPayload(client)
            );
        } catch (emailError) {
            console.error('Failed to send cancellation email:', emailError);
        }
    }

    if (booking.status === 'confirmed') {
        try {
            await processWaitlist(booking);
        } catch (wlErr) {
            console.error('Waitlist processing after booking delete failed:', wlErr);
        }
    }

    await Booking.deleteOne({ _id: booking._id, clientID: clientId });

    res.json({ message: 'Booking deleted successfully', id: String(booking._id) });
    recordTeamActivityFromRequest(req, {
      category: 'bookings',
      action: 'booking.deleted',
      summary: `Booking ${booking._id} permanently deleted`,
      metadata: { bookingId: String(booking._id) },
    });
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

// Utility function to generate time slots using operating hours + buffers
async function generateTimeSlots(date, existingBookings, duration = 60, hours = null, buffers = null) {
    const slots = [];
    const before = Number(buffers?.before) || 0;
    const after = Number(buffers?.after) || 0;
    const dur = parseInt(duration, 10) || 60;

    if (hours?.closed) return slots;

    const startMin = timeToMinutes(hours?.start || '09:00');
    const endMin = timeToMinutes(hours?.end || '17:00');
    const intervalMinutes = 15;

    for (let mins = startMin; mins + dur + after <= endMin; mins += intervalMinutes) {
        const hour = Math.floor(mins / 60);
        const minute = mins % 60;
        const slotTime = `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
        const slotEndMins = mins + dur;
        const endH = Math.floor(slotEndMins / 60);
        const endM = slotEndMins % 60;
        const slotEndTime = `${endH.toString().padStart(2, '0')}:${endM.toString().padStart(2, '0')}`;

        const paddedStart = mins - before;
        const paddedEnd = slotEndMins + after;

        const isAvailable = !existingBookings.some((booking) => {
            if (!booking.time) return false;
            const bStart = timeToMinutes(booking.time);
            const bEnd = booking.endTime
              ? timeToMinutes(booking.endTime)
              : bStart + (Number(booking.duration) || 60);
            return paddedStart < bEnd && bStart < paddedEnd;
        });

        if (isAvailable) {
            slots.push({
                time: slotTime,
                endTime: slotEndTime,
                duration: dur,
                available: true
            });
        }
    }

    return slots;
}

// Utility function to process waitlist — email + WhatsApp notify
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

    const client = await Client.findOne({ clientID: cancelledBooking.clientID });

    for (const entry of waitlistEntries) {
        try {
          if (entry.customerPhone) {
            await WhatsAppService.safeNotifyBookingReminder({
              clientId: cancelledBooking.clientID,
              to: entry.customerPhone,
              companyName: client?.companyName || cancelledBooking.clientID,
              when: `${cancelledBooking.date?.toISOString?.()?.slice(0, 10) || ''} ${cancelledBooking.time || ''}`.trim(),
              bookingRef: 'waitlist',
            });
          }
        } catch (waErr) {
          console.warn('[waitlist] whatsapp notify failed:', waErr.message);
        }

        try {
          if (client && clientCanSendMail(client) && entry.customerEmail) {
            // Reuse confirmation helper shape with a synthetic booking for waitlist open-slot notice
            await sendBookingConfirmationEmail(
              {
                customerName: entry.customerName,
                customerEmail: entry.customerEmail,
                customerPhone: entry.customerPhone,
                services: entry.services,
                date: cancelledBooking.date,
                time: cancelledBooking.time,
                endTime: cancelledBooking.endTime,
                notes: 'A preferred waitlist slot opened — contact us to confirm.',
                status: 'pending',
              },
              client.businessEmail,
              client.businessEmailPassword,
              client.clientName || client.companyName || cancelledBooking.clientID,
              client.emailSignature || '',
              clientEmailBrandingPayload(client)
            );
          }
        } catch (emailErr) {
          console.warn('[waitlist] email notify failed:', emailErr.message);
        }

        entry.status = 'notified';
        await entry.save();
        break;
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
        await sendBookingConfirmationEmail(
            booking,
            client.businessEmail,
            client.businessEmailPassword,
            client.clientName || clientId,
            client.emailSignature || '',
            clientEmailBrandingPayload(client)
        );
    } catch (emailError) {
        console.error('Failed to send confirmation email:', emailError);
    }

    WhatsAppService.safeNotifyBookingConfirmation({
        clientId: clientId || client.clientID,
        to: booking.customerPhone,
        companyName: client.companyName || client.clientName || clientId,
        bookingRef: String(booking._id),
        when: WhatsAppService.formatBookingWhen(booking),
    }).catch(() => {});

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

// Weekly recurrence (thin): create N weekly copies from a template body
router.post('/recurring', validateClient, wrapRoute(async (req, res) => {
  const weeks = Math.min(Math.max(Number(req.body.weeks) || 4, 1), 26);
  const template = { ...req.body };
  delete template.weeks;
  const created = [];
  const baseDate = new Date(template.date);
  if (Number.isNaN(baseDate.getTime())) {
    return res.status(400).json({ error: 'Valid date required' });
  }

  for (let i = 0; i < weeks; i += 1) {
    const d = new Date(baseDate);
    d.setDate(d.getDate() + i * 7);
    req.body = {
      ...template,
      date: d.toISOString(),
      recurring: { pattern: 'weekly', endDate: new Date(baseDate.getTime() + (weeks - 1) * 7 * 86400000) },
    };
    // Inline create for recurrence to avoid recursive router hop
    const clientId = req.clientId;
    const servicesList = Array.isArray(template.services)
      ? template.services
      : template.services
        ? [template.services]
        : [];
    if (!template.customerName || !template.customerEmail || !template.customerPhone || !servicesList.length) {
      return res.status(400).json({ error: 'customer + services required' });
    }
    const time = template.time;
    const duration = parseInt(template.duration, 10) || 60;
    const [h, m] = String(time).split(':').map(Number);
    const endDt = new Date(d);
    endDt.setHours(h, m + duration, 0, 0);
    const endTime = `${String(endDt.getHours()).padStart(2, '0')}:${String(endDt.getMinutes()).padStart(2, '0')}`;
    const assignedTo = template.assignedTo || null;
    const buffers = await buffersForServices(clientId, servicesList);
    try {
      await assertNoConflicts({
        clientId,
        date: d,
        time,
        endTime,
        durationMin: duration,
        assignedTo,
        bufferBeforeMin: buffers.before,
        bufferAfterMin: buffers.after,
      });
    } catch (e) {
      continue; // skip conflicting weeks
    }
    const doc = await Booking.create({
      customerName: template.customerName,
      customerEmail: String(template.customerEmail).toLowerCase().trim(),
      customerPhone: template.customerPhone,
      services: servicesList,
      date: d,
      time,
      endTime,
      duration,
      assignedTo,
      notes: template.notes || '',
      clientID: clientId,
      bookingType: 'service',
      status: 'confirmed',
      payment: { status: 'pending' },
      recurring: {
        pattern: 'weekly',
        endDate: new Date(baseDate.getTime() + (weeks - 1) * 7 * 86400000),
        parentBooking: created[0]?._id || undefined,
      },
    });
    created.push(doc);
  }

  res.status(201).json({ created: created.length, bookings: created });
}));

// Customer manage token (cancel / reschedule link)
router.post('/:id/manage-token', validateClient, wrapRoute(async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const secret = process.env.BOOKING_MANAGE_SECRET || process.env.JWT_SECRET || 'booking-manage';
  const token = jwt.sign(
    { bookingId: String(booking._id), clientID: req.clientId, purpose: 'booking_manage' },
    secret,
    { expiresIn: '7d' }
  );
  const base = process.env.PUBLIC_APP_URL || process.env.FRONTEND_URL || '';
  res.json({
    token,
    manageUrl: base ? `${base.replace(/\/$/, '')}/booking/manage?token=${encodeURIComponent(token)}` : token,
    expiresIn: '7d',
  });
}));

router.post('/manage/cancel', wrapRoute(async (req, res) => {
  const token = req.body?.token || req.query?.token;
  if (!token) return res.status(400).json({ error: 'token required' });
  const secret = process.env.BOOKING_MANAGE_SECRET || process.env.JWT_SECRET || 'booking-manage';
  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (decoded.purpose !== 'booking_manage') return res.status(401).json({ error: 'Invalid token purpose' });
  const booking = await Booking.findOne({ _id: decoded.bookingId, clientID: decoded.clientID });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  if (booking.status === 'cancelled') return res.json({ message: 'Already cancelled', booking });
  booking.status = 'cancelled';
  await booking.save();
  await processWaitlist(booking);
  res.json({ message: 'Booking cancelled', booking });
}));

router.post('/manage/reschedule', wrapRoute(async (req, res) => {
  const token = req.body?.token;
  const { date, time, duration } = req.body || {};
  if (!token || !date || !time) return res.status(400).json({ error: 'token, date, and time required' });
  const secret = process.env.BOOKING_MANAGE_SECRET || process.env.JWT_SECRET || 'booking-manage';
  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  const booking = await Booking.findOne({ _id: decoded.bookingId, clientID: decoded.clientID });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const bookingDuration = parseInt(duration, 10) || booking.duration || 60;
  const bookingDate = new Date(date);
  const [h, m] = String(time).split(':').map(Number);
  const endDt = new Date(bookingDate);
  endDt.setHours(h, m + bookingDuration, 0, 0);
  const endTime = `${String(endDt.getHours()).padStart(2, '0')}:${String(endDt.getMinutes()).padStart(2, '0')}`;
  const buffers = await buffersForServices(decoded.clientID, booking.services || []);
  try {
    await assertNoConflicts({
      clientId: decoded.clientID,
      date: bookingDate,
      time,
      endTime,
      durationMin: bookingDuration,
      assignedTo: booking.assignedTo,
      resourceId: booking.resourceId,
      excludeBookingId: booking._id,
      bufferBeforeMin: buffers.before,
      bufferAfterMin: buffers.after,
    });
  } catch (e) {
    return res.status(e.status || 409).json({ error: e.message });
  }
  booking.date = bookingDate;
  booking.time = time;
  booking.endTime = endTime;
  booking.duration = bookingDuration;
  await booking.save();
  res.json({ message: 'Booking rescheduled', booking });
}));

// Deposit PayFast ITN already uses payment-confirmation; allow setting deposit amount
router.post('/:id/deposit', validateClient, wrapRoute(async (req, res) => {
  const booking = await Booking.findOne({ _id: req.params.id, clientID: req.clientId });
  if (!booking) return res.status(404).json({ error: 'Booking not found' });
  const amount = Number(req.body.depositAmount ?? req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: 'depositAmount must be a positive number' });
  }
  booking.payment = booking.payment || {};
  booking.payment.depositAmount = amount;
  booking.payment.amount = amount;
  booking.payment.status = 'pending';
  booking.payment.currency = 'ZAR';
  await booking.save();
  res.json({
    booking,
    note: 'Complete payment via your PayFast checkout; webhook payment-confirmation will set deposit-paid.',
  });
}));

module.exports = router;