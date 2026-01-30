const nodemailer = require('nodemailer');
const Product = require('../models/product');

async function sendWithRetry(transporter, mailOptions, retries = 3, delayMs = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const result = await transporter.sendMail(mailOptions);
            
            if (attempt > 1) {
                console.log(`✅ Email delivered successfully after ${attempt} attempts`);
            } else {
                console.log(`✅ Email sent successfully on first attempt`);
            }
            
            return result;
        } catch (err) {
            if (attempt === retries) {
                console.error(`💥 Final email attempt failed:`, err.message);
                throw new Error('Failed to send email after multiple attempts.');
            }
            // Don't log every intermediate failure to reduce noise
            console.log(`🔄 Email attempt ${attempt} failed, retrying in ${delayMs/1000} seconds...`);
            await new Promise(res => setTimeout(res, delayMs));
            delayMs *= 1.5; // Exponential backoff
        }
    }
}

function getFormattedClientName(clientName) {
    return clientName
        ? 'The ' + clientName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim() + ' Team'
        : 'The Khana Technologies Team';
}

function createTransporter(bEmail, BEPass) {
    return nodemailer.createTransport({
        host: `mail.${bEmail.split('@')[1]}`, // Use the domain from the email
        port: 465, // SSL port
        secure: true, // true for SSL
        auth: {
            user: bEmail,
            pass: BEPass
        },
        tls: {
            rejectUnauthorized: false, // Allow self-signed certificates if needed
            minVersion: 'TLSv1.2' // Force modern TLS
        },
        // Connection pooling to prevent "too many connections"
        pool: true,
        maxConnections: 1,
        maxMessages: 5,
        connectionTimeout: 30000,
        greetingTimeout: 30000
    });
}

function formatBookingDate(date) {
    return new Date(date).toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
}

// -----------------------------
// Booking Confirmation Email
// -----------------------------
async function sendBookingConfirmationEmail(booking, bEmail, BEPass, clientName) {
    console.log(booking, bEmail, BEPass, clientName)
    const formattedClientName = getFormattedClientName(clientName);
    const transporter = createTransporter(bEmail, BEPass);
    const formattedDate = formatBookingDate(booking.date);

    const servicesList = booking.services.map(service => `<li>${service}</li>`).join('');

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Booking Confirmed! 🎉</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your booking has been confirmed. We're looking forward to seeing you!</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Booking Details</h3>
                <p><strong>Date:</strong> ${formattedDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong></p>
                <ul>${servicesList}</ul>
                ${booking.notes ? `<p><strong>Notes:</strong> ${booking.notes}</p>` : ''}
                ${booking.payment.amount ? `<p><strong>Amount:</strong> R${booking.payment.amount}</p>` : ''}
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0;">📍 Location & Preparation</h4>
                <p>Please arrive 10 minutes before your scheduled time.</p>
                <p>If you need to reschedule or cancel, please contact us at least 24 hours in advance.</p>
            </div>

            <p style="margin-top: 30px;">If you have any questions, feel free to reply to this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

    await sendWithRetry(transporter, {
        from: bEmail,
        to: booking.customerEmail,
        subject: `Booking Confirmation - ${formattedDate}`,
        html: emailContent
    });

    // Send notification to business
    await sendWithRetry(transporter, {
        from: bEmail,
        to: bEmail,
        subject: `New Booking - ${booking.customerName}`,
        html: emailContent
    });

    console.log('Booking confirmation email sent successfully');
}

// -----------------------------
// Booking Reminder Email
// -----------------------------
async function sendBookingReminderEmail(booking, bEmail, BEPass, clientName) {
    const formattedClientName = getFormattedClientName(clientName);
    const transporter = createTransporter(bEmail, BEPass);
    const formattedDate = formatBookingDate(booking.date);

    const servicesList = booking.services.map(service => `<li>${service}</li>`).join('');

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Friendly Reminder: Booking Tomorrow! ⏰</h2>
            <p>Hi ${booking.customerName},</p>
            <p>This is a friendly reminder about your booking scheduled for tomorrow.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Booking Details</h3>
                <p><strong>Date:</strong> ${formattedDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong></p>
                <ul>${servicesList}</ul>
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #d4edda; border-left: 4px solid #28a745;">
                <h4 style="margin-top: 0;">💡 Tips for Your Visit</h4>
                <p>• Please arrive 10 minutes early</p>
                <p>• Bring any necessary documents or items</p>
                <p>• Contact us if you're running late</p>
            </div>

            <p>We're looking forward to seeing you!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

    await sendWithRetry(transporter, {
        from: bEmail,
        to: booking.customerEmail,
        subject: `Reminder: Your Booking Tomorrow - ${formattedDate}`,
        html: emailContent
    });

    console.log('Booking reminder email sent successfully');
}

// -----------------------------
// Payment Confirmation Email
// -----------------------------
async function sendPaymentConfirmationEmail(booking, bEmail, BEPass, clientName) {
    const formattedClientName = getFormattedClientName(clientName);
    const transporter = createTransporter(bEmail, BEPass);
    const formattedDate = formatBookingDate(booking.date);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Payment Confirmed! ✅</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your payment for the upcoming booking has been successfully processed.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Payment Details</h3>
                <p><strong>Amount:</strong> R${booking.payment.amount}</p>
                <p><strong>Date:</strong> ${new Date(booking.payment.paidAt).toLocaleDateString()}</p>
                <p><strong>Transaction ID:</strong> ${booking.payment.transactionId}</p>
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Booking Details</h3>
                <p><strong>Date:</strong> ${formattedDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong> ${booking.services.join(', ')}</p>
            </div>

            <p>Your booking is now confirmed and we're looking forward to seeing you!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

    await sendWithRetry(transporter, {
        from: bEmail,
        to: booking.customerEmail,
        subject: `Payment Confirmed - Booking ${formattedDate}`,
        html: emailContent
    });

    console.log('Payment confirmation email sent successfully');
}

// -----------------------------
// Booking Cancellation Email
// -----------------------------
async function sendBookingCancellationEmail(booking, bEmail, BEPass, clientName, reason = '') {
    const formattedClientName = getFormattedClientName(clientName);
    const transporter = createTransporter(bEmail, BEPass);
    const formattedDate = formatBookingDate(booking.date);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Booking Cancelled</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your booking has been cancelled.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #f8d7da; border-left: 4px solid #dc3545;">
                <h3 style="margin-top: 0;">Cancelled Booking Details</h3>
                <p><strong>Date:</strong> ${formattedDate}</p>
                <p><strong>Time:</strong> ${booking.time}</p>
                <p><strong>Services:</strong> ${booking.services.join(', ')}</p>
                ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
            </div>

            ${booking.payment.status === 'paid' ? `
            <div style="margin: 20px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0;">Refund Information</h4>
                <p>Your payment will be refunded within 5-7 business days.</p>
            </div>
            ` : ''}

            <p>We hope to see you again in the future!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

    await sendWithRetry(transporter, {
        from: bEmail,
        to: booking.customerEmail,
        subject: `Booking Cancelled - ${formattedDate}`,
        html: emailContent
    });

    console.log('Booking cancellation email sent successfully');
}

// -----------------------------
// Booking Rescheduling Email
// -----------------------------
async function sendReschedulingEmail(booking, oldDetails, bEmail, BEPass, clientName, reason) {
    const formattedClientName = getFormattedClientName(clientName);
    const transporter = createTransporter(bEmail, BEPass);
    const newFormattedDate = formatBookingDate(booking.date);
    const oldFormattedDate = formatBookingDate(oldDetails.date);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Booking Rescheduled 🔄</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your booking has been successfully rescheduled.</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0;">Previous Booking</h4>
                <p><strong>Date:</strong> ${oldFormattedDate}</p>
                <p><strong>Time:</strong> ${oldDetails.time} - ${oldDetails.endTime}</p>
                ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">New Booking Details</h3>
                <p><strong>Date:</strong> ${newFormattedDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong> ${booking.services.join(', ')}</p>
            </div>

            <p>We look forward to seeing you at your new scheduled time!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

    await sendWithRetry(transporter, {
        from: bEmail,
        to: booking.customerEmail,
        subject: `Booking Rescheduled - ${newFormattedDate}`,
        html: emailContent
    });

    console.log('Booking rescheduling email sent successfully');
}

// -----------------------------
// Order Confirmation Email
// -----------------------------
async function sendOrderConfirmationEmail(clientEmail, orderItems, bEmail, BEPass, shipping, clientName, orderID) {
    const formattedClientName = getFormattedClientName(clientName);
    const transporter = createTransporter(bEmail, BEPass);

    async function populateOrderItems(items) {
        return Promise.all(items.map(async item => {
            const populatedItem = await Product.findById(item.product);
            return { ...item, product: populatedItem };
        }));
    }

    const populatedOrderItems = await populateOrderItems(orderItems);
    const parentOrder = populatedOrderItems[0]?.$__?.parent;

    const orderItemsHtml = populatedOrderItems.map(item => {
        const variant = item._doc.variant;
        const variantHtml = (variant && variant !== 'Default') 
            ? `<div style="color: #777; font-size: 13px; margin-top: 4px;"><em>Variant:</em> ${variant}</div>` 
            : '';
        return `
            <tr>
                <td style="padding: 10px; border: 1px solid #ddd;">
                    <img src="${item.product.images[0]}" alt="${item.product.productName}" style="height: 80px; border-radius: 8px;">
                </td>
                <td style="padding: 10px; border: 1px solid #ddd;">
                    <div><strong>${item.product.productName}</strong></div>${variantHtml}
                </td>
                <td style="padding: 10px; border: 1px solid #ddd;">${item._doc.quantity}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">R${item._doc.variantPrice}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">R${(item._doc.quantity * item._doc.variantPrice).toFixed(2)}</td>
            </tr>
        `;
    }).join('');

    const subtotal = populatedOrderItems.reduce((total, item) => total + (item._doc.quantity * item._doc.variantPrice), 0);
    const total = subtotal + shipping;

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Thank You for Your Order!</h2>
            <p>Hi there,</p>
            <p>We're thrilled you've chosen to shop with us. Here's your order summary:</p>

            <div style="margin: 20px 0; padding: 10px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h4>Order ID</h4>
                <p>${orderID}</p>
            </div>

            <div style="margin: 20px 0; padding: 10px; background-color: #f9f9f9; border-left: 4px solid #4CAF50;">
                <h4>Delivery Address</h4>
                <p><strong>Name:</strong> ${parentOrder.customer.customerFirstName} ${parentOrder.customer.customerLastName}</p>
                <p><strong>Address:</strong> ${parentOrder.address}</p>
                <p><strong>Postal Code:</strong> ${parentOrder.postalCode}</p>
            </div>

            <table style="width: 100%; border-collapse: collapse; margin-top: 20px;">
                <thead>
                    <tr style="background-color: #f5f5f5;">
                        <th style="padding: 10px; border: 1px solid #ddd;"></th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Product</th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Qty</th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Price</th>
                        <th style="padding: 10px; border: 1px solid #ddd;">Total</th>
                    </tr>
                </thead>
                <tbody>${orderItemsHtml}</tbody>
            </table>

            <div style="margin-top: 20px;">
                <p><strong>Subtotal:</strong> R${subtotal.toFixed(2)}</p>
                <p><strong>Shipping:</strong> R${shipping.toFixed(2)}</p>
                <p style="font-size: 18px;"><strong>Total Price:</strong> R${total.toFixed(2)}</p>
            </div>

            <p style="margin-top: 30px;">If you have any questions, feel free to reply to this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>

            <hr style="margin-top: 40px;">
            <p style="font-size: 12px; color: #888;">This email is a confirmation of your recent purchase from ${formattedClientName.replace('The ', '').replace(' Team', '')}.</p>
        </div>
    `;

    // Send to client and business
    await sendWithRetry(transporter, { from: bEmail, to: clientEmail, subject: 'Order Confirmation', html: emailContent });
    await sendWithRetry(transporter, { from: bEmail, to: bEmail, subject: 'New Order Received', html: emailContent });

    console.log('Order confirmation email sent successfully');
}

// -----------------------------
// Order Status Update Email
// -----------------------------
async function sendOrderStatusUpdateEmail(clientEmail, customerName, status, orderID, websiteURL, bEmail, BEPass, clientName, trackingID, trackingLink) {
    const formattedClientName = getFormattedClientName(clientName);

    const statusMessages = {
        processed: { subject: 'Your Order Has Been Processed', message: 'We\'ve finished preparing your order and it\'s now processed. It will be shipped soon.' },
        shipped: { subject: 'Your Order Has Been Shipped', message: 'Good news! Your order has been shipped. You can track it below.' },
        delivered: { subject: 'Your Order Has Been Delivered', message: 'Your order has been marked as delivered. We hope you enjoy your purchase!' }
    };

    const { subject, message } = statusMessages[status.toLowerCase()] || { subject: 'Order Update', message: 'There\'s an update regarding your order.' };

    const transporter = createTransporter(bEmail, BEPass);

    const viewOrderLink = `${websiteURL}/login`;
    const trackOrderLink = `${trackingLink || viewOrderLink}`;

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Order Update: ${status.toUpperCase()}</h2>
            <p>Hi ${customerName},</p>
            <p>${message}</p>
            <div style="margin: 20px 0; padding: 10px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h4>Order ID</h4>
                <p>${orderID}</p>
            </div>
            <p><a href="${viewOrderLink}" style="background-color: #2196F3; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">View My Order</a></p>
            ${status === 'shipped' ? `<p><a href="${trackOrderLink}" style="background-color: #4CAF50; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">Track My Order</a></p>` : ''}
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

    await sendWithRetry(transporter, { from: bEmail, to: clientEmail, subject, html: emailContent });
    await sendWithRetry(transporter, { from: bEmail, to: bEmail, subject, html: emailContent });

    console.log(`Order status email (${status}) sent successfully`);
}

// -----------------------------
// Accommodation Confirmation Email
// -----------------------------
async function sendAccommodationConfirmationEmail(booking, bEmail, BEPass, clientName) {
    const formattedClientName = getFormattedClientName(clientName);
    const transporter = createTransporter(bEmail, BEPass);
    
    const checkInDate = formatBookingDate(booking.accommodation.checkIn);
    const checkOutDate = formatBookingDate(booking.accommodation.checkOut);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Accommodation Booking Confirmed! 🏨</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your accommodation booking has been confirmed. We look forward to hosting you!</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Accommodation Details</h3>
                <p><strong>Check-in:</strong> ${checkInDate} (from 14:00)</p>
                <p><strong>Check-out:</strong> ${checkOutDate} (until 11:00)</p>
                <p><strong>Duration:</strong> ${booking.accommodation.numberOfNights} night(s)</p>
                <p><strong>Guests:</strong> ${booking.accommodation.numberOfGuests}</p>
                <p><strong>Room Type:</strong> ${booking.accommodation.roomType}</p>
                ${booking.accommodation.specialRequests ? `<p><strong>Special Requests:</strong> ${booking.accommodation.specialRequests}</p>` : ''}
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #fff3cd; border-left: 4px solid #ffc107;">
                <h4 style="margin-top: 0;">📍 Location & Arrival</h4>
                <p>Please bring your ID/document for check-in.</p>
                <p>Early check-in and late check-out are subject to availability.</p>
            </div>

            ${booking.payment.amount ? `
            <div style="margin: 20px 0; padding: 15px; background-color: #d4edda; border-left: 4px solid #28a745;">
                <h4 style="margin-top: 0;">💰 Payment Details</h4>
                <p><strong>Total Amount:</strong> R${booking.payment.amount}</p>
                ${booking.payment.depositAmount ? `<p><strong>Deposit Paid:</strong> R${booking.payment.depositAmount}</p>` : ''}
                ${booking.payment.balanceDue ? `<p><strong>Balance Due:</strong> R${booking.payment.balanceDue} (before ${new Date(booking.payment.dueDate).toLocaleDateString()})</p>` : ''}
            </div>
            ` : ''}

            <p style="margin-top: 30px;">If you have any questions about your stay, feel free to reply to this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

    await sendWithRetry(transporter, {
        from: bEmail,
        to: booking.customerEmail,
        subject: `Accommodation Confirmation - ${checkInDate} to ${checkOutDate}`,
        html: emailContent
    });

    // Send notification to business
    await sendWithRetry(transporter, {
        from: bEmail,
        to: bEmail,
        subject: `New Accommodation Booking - ${booking.customerName}`,
        html: emailContent
    });

    console.log('Accommodation confirmation email sent successfully');
}

// -----------------------------
// Mixed Booking Confirmation Email
// -----------------------------
async function sendMixedBookingConfirmationEmail(booking, bEmail, BEPass, clientName) {
    const formattedClientName = getFormattedClientName(clientName);
    const transporter = createTransporter(bEmail, BEPass);
    
    const serviceDate = formatBookingDate(booking.date);
    const checkInDate = formatBookingDate(booking.accommodation.checkIn);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Booking Confirmed! 🎉🏨</h2>
            <p>Hi ${booking.customerName},</p>
            <p>Your combined service and accommodation booking has been confirmed!</p>

            <div style="margin: 20px 0; padding: 15px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h3 style="margin-top: 0;">Service Details</h3>
                <p><strong>Date:</strong> ${serviceDate}</p>
                <p><strong>Time:</strong> ${booking.time} - ${booking.endTime}</p>
                <p><strong>Services:</strong> ${booking.services.join(', ')}</p>
            </div>

            <div style="margin: 20px 0; padding: 15px; background-color: #e8f5e8; border-left: 4px solid #4CAF50;">
                <h3 style="margin-top: 0;">Accommodation Details</h3>
                <p><strong>Check-in:</strong> ${checkInDate}</p>
                <p><strong>Duration:</strong> ${booking.accommodation.numberOfNights} night(s)</p>
                <p><strong>Room Type:</strong> ${booking.accommodation.roomType}</p>
            </div>

            <p style="margin-top: 30px;">We look forward to serving you and providing a comfortable stay!</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

    await sendWithRetry(transporter, {
        from: bEmail,
        to: booking.customerEmail,
        subject: `Booking Confirmation - Services & Accommodation`,
        html: emailContent
    });

    console.log('Mixed booking confirmation email sent successfully');
}

// -----------------------------
// Reset Password Email
// -----------------------------
async function sendResetPasswordEmail(clientEmail, customerName, websiteURL, resetLink, bEmail, BEPass, clientName) {
    const formattedClientName = getFormattedClientName(clientName);
    const transporter = createTransporter(bEmail, BEPass);

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Reset Your Password</h2>
            <p>Hi ${customerName},</p>
            <p>We received a request to reset your password for your account at <strong>${websiteURL}</strong>.</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
                Reset My Password
              </a>
            </div>
            <p>This link will expire shortly. If you did not request this, please ignore this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>
        </div>
    `;

    await sendWithRetry(transporter, { from: bEmail, to: clientEmail, subject: 'Reset Password', html: emailContent });
    console.log('Reset password email sent successfully');
}

module.exports = {
    sendBookingConfirmationEmail,
    sendBookingReminderEmail,
    sendPaymentConfirmationEmail,
    sendBookingCancellationEmail,
    sendOrderConfirmationEmail,
    sendOrderStatusUpdateEmail,
    sendResetPasswordEmail
};