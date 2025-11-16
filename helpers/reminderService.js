const cron = require('node-cron');
const Booking = require('../models/booking');
const { sendBookingReminderEmail } = require('../utils/email');

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

        // Run every hour to check for upcoming bookings (at minute 0 of every hour)
        cron.schedule('0 * * * *', async () => {
            try {
                console.log('⏰ Checking for upcoming bookings to send reminders...');
                await this.checkUpcomingBookings();
            } catch (error) {
                console.error('❌ Error in reminder service:', error);
            }
        });

        // Also run immediately on startup to catch any missed reminders
        setTimeout(async () => {
            try {
                console.log('🔍 Running initial reminder check...');
                await this.checkUpcomingBookings();
            } catch (error) {
                console.error('❌ Error in initial reminder check:', error);
            }
        }, 10000); // Wait 10 seconds after startup

        console.log('✅ Booking Reminder Service scheduled successfully');
    }

    stop() {
        this.isRunning = false;
        console.log('🛑 Booking Reminder Service stopped');
    }

    async checkUpcomingBookings() {
        try {
            const now = new Date();
            const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);

            console.log(`🔍 Looking for bookings between ${now.toISOString()} and ${twentyFourHoursFromNow.toISOString()}`);

            const upcomingBookings = await Booking.find({
                date: {
                    $gte: now,
                    $lte: twentyFourHoursFromNow
                },
                status: { $in: ['confirmed', 'scheduled'] },
                $or: [
                    { reminders: { $exists: false } },
                    { reminders: { $size: 0 } },
                    { 'reminders.sent': false }
                ]
            }).populate('assignedTo');

            console.log(`📅 Found ${upcomingBookings.length} upcoming bookings to process`);

            let remindersSent = 0;
            let errors = 0;

            for (const booking of upcomingBookings) {
                try {
                    const bookingDate = new Date(booking.date);
                    const [hours, minutes] = booking.time.split(':').map(Number);
                    bookingDate.setHours(hours, minutes, 0, 0);
                    
                    const timeUntilBooking = bookingDate.getTime() - now.getTime();
                    
                    // Send reminder if booking is within 24 hours but more than 1 hour away
                    if (timeUntilBooking <= 24 * 60 * 60 * 1000 && timeUntilBooking > 60 * 60 * 1000) {
                        console.log(`✉️ Sending reminder for booking ${booking._id} (${booking.customerName})`);
                        
                        await sendBookingReminderEmail(
                            booking,
                            process.env.BUSINESS_EMAIL,
                            process.env.BUSINESS_EMAIL_PASS,
                            booking.clientID
                        );

                        // Update booking with reminder record
                        await Booking.findByIdAndUpdate(booking._id, {
                            $push: {
                                reminders: {
                                    type: 'email',
                                    scheduledTime: new Date(),
                                    sent: true,
                                    sentAt: new Date()
                                }
                            }
                        });

                        remindersSent++;
                        console.log(`✅ Reminder sent for booking ${booking._id}`);
                    }
                } catch (bookingError) {
                    errors++;
                    console.error(`❌ Failed to process reminder for booking ${booking._id}:`, bookingError);
                }
            }

            console.log(`📊 Reminder service completed: ${remindersSent} sent, ${errors} errors`);
            
        } catch (error) {
            console.error('💥 Critical error in reminder service:', error);
            throw error;
        }
    }

    // Manual trigger for testing
    async triggerManualCheck() {
        console.log('🔧 Manual trigger of reminder service');
        await this.checkUpcomingBookings();
    }
}

module.exports = ReminderService;