// helpers/reminderService.js
const cron = require('node-cron');
const Booking = require('../models/booking');
const Client = require('../models/client');
const { 
    sendBookingReminderEmail,
    sendCheckInReminderEmail,
    sendCheckOutReminderEmail 
} = require('../utils/email');

class ReminderService {
    constructor() {
        this.isRunning = false;
        this.start();
    }

    start() {
        if (this.isRunning) {
            console.log('Reminder service is already running');
            return;
        }

        console.log('🚀 Starting Booking Reminder Service...');
        this.isRunning = true;

        // Run every 5 minutes to check for reminders
        cron.schedule('*/5 * * * *', async () => {
            try {
                console.log('⏰ Checking for booking reminders...');
                await this.checkUpcomingBookings();
            } catch (error) {
                console.error('❌ Error in reminder service:', error);
            }
        });

        // Also run immediately on startup
        setTimeout(async () => {
            try {
                console.log('🔍 Running initial reminder check...');
                await this.checkUpcomingBookings();
            } catch (error) {
                console.error('❌ Error in initial reminder check:', error);
            }
        }, 15000);

        console.log('✅ Booking Reminder Service scheduled successfully');
    }

    stop() {
        this.isRunning = false;
        console.log('🛑 Booking Reminder Service stopped');
    }

   async checkUpcomingBookings() {
    try {
        const now = new Date();
        
        console.log(`🔍 Checking for due reminders at: ${now.toISOString()}`);

        // SIMPLE FIX: Find bookings where reminders are scheduled to be sent NOW or in the past
        // but haven't been sent yet
        const dueReminders = await Booking.find({
            'reminders.sent': false,
            'reminders.scheduledTime': { $lte: now },
            'status': { $in: ['confirmed', 'scheduled'] }
        }).populate('assignedTo');

        console.log(`📅 Found ${dueReminders.length} bookings with due reminders`);

        let remindersSent = 0;
        let errors = 0;

        for (const booking of dueReminders) {
            try {
                console.log(`📋 Processing booking ${booking._id}: ${booking.customerName}`);
                
                // Find the unsent reminder
                const unsentReminder = booking.reminders.find(r => !r.sent && r.scheduledTime <= now);
                if (!unsentReminder) continue;

                const client = await Client.findOne({ clientID: booking.clientID });
                if (!client) {
                    console.error(`❌ Client not found for booking ${booking._id}`);
                    errors++;
                    continue;
                }

                console.log(`✉️ Sending reminder for booking ${booking._id}`);

                // Send appropriate email based on reminder type
                if (unsentReminder.reminderType === 'checkin') {
                    await sendCheckInReminderEmail(
                        booking,
                        client.businessEmail,
                        client.businessEmailPassword,
                        client.clientName || booking.clientID
                    );
                } else if (unsentReminder.reminderType === 'checkout') {
                    await sendCheckOutReminderEmail(
                        booking,
                        client.businessEmail,
                        client.businessEmailPassword,
                        client.clientName || booking.clientID
                    );
                } else {
                    await sendBookingReminderEmail(
                        booking,
                        client.businessEmail,
                        client.businessEmailPassword,
                        client.clientName || booking.clientID
                    );
                }

                // Mark this specific reminder as sent
                await Booking.updateOne(
                    { 
                        _id: booking._id,
                        'reminders._id': unsentReminder._id 
                    },
                    { 
                        $set: { 
                            'reminders.$.sent': true,
                            'reminders.$.sentAt': new Date()
                        } 
                    }
                );

                remindersSent++;
                console.log(`✅ Reminder sent for booking ${booking._id}`);

            } catch (bookingError) {
                errors++;
                console.error(`❌ Failed to process reminder for booking ${booking._id}:`, bookingError.message);
            }
        }

        console.log(`📊 Reminder service completed: ${remindersSent} reminders sent, ${errors} errors`);
        
    } catch (error) {
        console.error('💥 Critical error in reminder service:', error);
        throw error;
    }
}
    async processBookingReminders(booking, client, now) {
        let remindersSent = 0;

        // SERVICE REMINDERS
        if (booking.bookingType === 'service' || booking.bookingType === 'mixed') {
            const serviceDateTime = new Date(booking.date);
            const [hours, minutes] = booking.time.split(':').map(Number);
            serviceDateTime.setHours(hours, minutes, 0, 0);
            
            const hoursUntilService = (serviceDateTime.getTime() - now.getTime()) / (1000 * 60 * 60);
            const isSameDay = serviceDateTime.toDateString() === now.toDateString();
            
            let shouldSendServiceReminder = false;
            let reminderType = 'standard';
            
            if (isSameDay) {
                shouldSendServiceReminder = hoursUntilService <= 4 && hoursUntilService > 0.5;
                reminderType = 'same-day';
            } else {
                shouldSendServiceReminder = hoursUntilService <= 24 && hoursUntilService > 2;
                reminderType = 'standard';
            }

            const hasServiceReminder = booking.reminders.some(r => 
                r.reminderType === 'service' && r.sent
            );

            if (shouldSendServiceReminder && !hasServiceReminder) {
                console.log(`✉️ Sending ${reminderType} service reminder for booking ${booking._id}`);
                
                await sendBookingReminderEmail(
                    booking,
                    client.businessEmail,
                    client.businessEmailPassword,
                    client.clientName || booking.clientID
                );

                await this.markReminderSent(booking, 'service');
                remindersSent++;
            }
        }

        // ACCOMMODATION CHECK-IN REMINDERS
        if (booking.bookingType === 'accommodation' || booking.bookingType === 'mixed') {
            const checkInDate = new Date(booking.accommodation.checkIn);
            const hoursUntilCheckIn = (checkInDate.getTime() - now.getTime()) / (1000 * 60 * 60);
            
            // Send check-in reminder 24 hours before
            if (hoursUntilCheckIn <= 24 && hoursUntilCheckIn > 2) {
                const hasCheckInReminder = booking.reminders.some(r => 
                    r.reminderType === 'checkin' && r.sent
                );

                if (!hasCheckInReminder) {
                    console.log(`🏨 Sending check-in reminder for booking ${booking._id}`);
                    
                    await sendCheckInReminderEmail(
                        booking,
                        client.businessEmail,
                        client.businessEmailPassword,
                        client.clientName || booking.clientID
                    );

                    await this.markReminderSent(booking, 'checkin');
                    remindersSent++;
                }
            }
        }

        // ACCOMMODATION CHECK-OUT REMINDERS
        if (booking.bookingType === 'accommodation' || booking.bookingType === 'mixed') {
            const checkOutDate = new Date(booking.accommodation.checkOut);
            const hoursUntilCheckOut = (checkOutDate.getTime() - now.getTime()) / (1000 * 60 * 60);
            
            // Send check-out reminder 24 hours before
            if (hoursUntilCheckOut <= 24 && hoursUntilCheckOut > 2) {
                const hasCheckOutReminder = booking.reminders.some(r => 
                    r.reminderType === 'checkout' && r.sent
                );

                if (!hasCheckOutReminder) {
                    console.log(`🏨 Sending check-out reminder for booking ${booking._id}`);
                    
                    await sendCheckOutReminderEmail(
                        booking,
                        client.businessEmail,
                        client.businessEmailPassword,
                        client.clientName || booking.clientID
                    );

                    await this.markReminderSent(booking, 'checkout');
                    remindersSent++;
                }
            }
        }

        return remindersSent;
    }

    async markReminderSent(booking, reminderType) {
        await Booking.findByIdAndUpdate(booking._id, {
            $push: {
                reminders: {
                    type: 'email',
                    scheduledTime: new Date(),
                    sent: true,
                    sentAt: new Date(),
                    reminderType: reminderType
                }
            }
        });
    }

    // Manual trigger for testing
    async triggerManualCheck() {
        console.log('🔧 Manual trigger of reminder service');
        await this.checkUpcomingBookings();
    }

    // Test function for specific booking
    async testReminderForBooking(bookingId) {
        try {
            const booking = await Booking.findById(bookingId)
                .populate('assignedTo')
                .populate('resourceId');
                
            if (!booking) {
                console.log('❌ Booking not found');
                return;
            }

            const client = await Client.findOne({ clientID: booking.clientID });
            if (!client) {
                console.log('❌ Client not found');
                return;
            }

            console.log('🧪 Testing reminder for booking:', {
                id: booking._id,
                customer: booking.customerName,
                bookingType: booking.bookingType,
                client: client.clientName,
                tier: client.tier
            });

            // Test appropriate reminder based on booking type
            if (booking.bookingType === 'accommodation') {
                await sendCheckInReminderEmail(
                    booking,
                    client.businessEmail,
                    client.businessEmailPassword,
                    client.clientName
                );
            } else {
                await sendBookingReminderEmail(
                    booking,
                    client.businessEmail,
                    client.businessEmailPassword,
                    client.clientName
                );
            }

            console.log('✅ Test reminder sent successfully!');
        } catch (error) {
            console.error('❌ Test failed:', error);
        }
    }

    // Get stats about upcoming reminders
    async getReminderStats() {
        try {
            const now = new Date();
            const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

            const upcomingBookings = await Booking.find({
                $or: [
                    { date: { $gte: now, $lte: twentyFourHoursFromNow } },
                    { 'accommodation.checkIn': { $gte: now, $lte: twentyFourHoursFromNow } },
                    { 'accommodation.checkOut': { $gte: now, $lte: twentyFourHoursFromNow } }
                ],
                status: { $in: ['confirmed', 'scheduled'] }
            });

            const stats = {
                totalUpcoming: upcomingBookings.length,
                serviceBookings: upcomingBookings.filter(b => b.bookingType === 'service').length,
                accommodationBookings: upcomingBookings.filter(b => b.bookingType === 'accommodation').length,
                mixedBookings: upcomingBookings.filter(b => b.bookingType === 'mixed').length,
                withRemindersSent: upcomingBookings.filter(b => 
                    b.reminders && b.reminders.some(r => r.sent)
                ).length,
                withoutReminders: upcomingBookings.filter(b => 
                    !b.reminders || !b.reminders.some(r => r.sent)
                ).length
            };

            return stats;
        } catch (error) {
            console.error('Error getting reminder stats:', error);
            throw error;
        }
    }
}

module.exports = ReminderService;