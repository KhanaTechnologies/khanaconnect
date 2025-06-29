const nodemailer = require('nodemailer');
const { OrderItem } = require('../models/orderItem');
const Product = require('../models/product');

// Reusable retry logic for sending emails
async function sendWithRetry(transporter, mailOptions, retries = 3, delayMs = 1500) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await transporter.sendMail(mailOptions);
            return true;
        } catch (err) {
            console.error(`Attempt ${attempt} failed:`, err.message);
            if (attempt < retries) await new Promise(res => setTimeout(res, delayMs));
        }
    }
    throw new Error('Failed to send email after multiple attempts.');
}

// Function to send order confirmation email
async function sendOrderConfirmationEmail(clientEmail, orderItems, bEmail, BEPass, shipping, clientName, orderID) {
console.log(clientEmail,bEmail)

    const formattedClientName = clientName
    ? 'The ' + clientName
        .replace(/([A-Z])/g, ' $1')         // Add space before capital letters
        .replace(/^./, str => str.toUpperCase()) // Capitalize first letter
        .trim() + ' Team'
    : 'The Khana Technologies Team';


    // Create a nodemailer transporter
    const transporter = nodemailer.createTransport({
        host: 'smtpout.secureserver.net', // GoDaddy SMTP server
        port: 465, // GoDaddy SMTP port (465 or 587)
        secure: true, // true for 465, false for other ports
        auth: {
            user: bEmail, // Your GoDaddy email address
            pass: BEPass // Your GoDaddy email password
        }
    });

    try {
        // console.log('Order items : '+orderItems);

        // Function to populate the order items
        async function populateOrderItems(orderItems) {
            return Promise.all(orderItems.map(async item => {
                // Populate the product field
                const populatedItem = await Product.findById(item.product);
                return {
                    ...item,
                    product: populatedItem
                };
            }));
        }

        // Populate the order items
        const populatedOrderItems = await populateOrderItems(orderItems);
        // console.log('populatedOrderItems: '+populatedOrderItems);
        // Create the order items HTML
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
                    <div><strong>${item.product.productName}</strong></div>
                    ${variantHtml}
                </td>
                <td style="padding: 10px; border: 1px solid #ddd;">${item._doc.quantity}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">R${item._doc.variantPrice}</td>
                <td style="padding: 10px; border: 1px solid #ddd;">R${(item._doc.quantity * item._doc.variantPrice).toFixed(2)}</td>
            </tr>
        `;
    }).join('');


        // Calculate the total price
        const subtotal = populatedOrderItems.reduce((total, item) => total + (item._doc.quantity * item._doc.variantPrice), 0);
        const total = subtotal + shipping;
     
        // Email HTML content
        const emailContent = `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
                <h2 style="text-align: center; color: #444;">Thank You for Your Order!</h2>
                <p>Hi there,</p>
                <p>We're thrilled you've chosen to shop with us. Here's your order summary:</p>

                <!-- Order ID Section -->
                <div style="margin: 20px 0; padding: 10px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                    <h4 style="margin-bottom: 10px;">Order ID</h4>
                    <p>${orderID}</p>
                </div>

                <!-- Delivery Address Section -->
                <div style="margin: 20px 0; padding: 10px; background-color: #f9f9f9; border-left: 4px solid #4CAF50;">
                    <h4 style="margin-bottom: 10px;">Delivery Address</h4>
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
                    <tbody>
                        ${orderItemsHtml}
                    </tbody>
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
        console.log('about to send email');
        // Send email to client
        await sendWithRetry(transporter, { from: bEmail, to: clientEmail, subject: 'Order Confirmation', html: emailContent });

        console.log('Order confirmation email sent to client successfully');

        // Send email to business (yourself)
        await sendWithRetry(transporter, { from: bEmail, to: bEmail, subject: 'New Order Received', html: emailContent });

        console.log('Order confirmation email sent to business successfully');

    } catch (error) {
        console.error('Error sending order confirmation email:', error);
        throw error; // Throw error to handle it in the calling function
    }
}




async function sendOrderStatusUpdateEmail(
    clientEmail,
    customerName,
    status,
    orderID,
    websiteURL,
    bEmail,
    BEPass,
    clientName,
    trackingID,
    trackingLink
) {
    const formattedClientName = clientName
        ? 'The ' + clientName
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, str => str.toUpperCase())
            .trim() + ' Team'
        : 'The Khana Technologies Team';

    const statusMessages = {
        processed: {
            subject: 'Your Order Has Been Processed',
            message: 'We’ve finished preparing your order and it’s now processed. It will be shipped soon.'
        },
        shipped: {
            subject: 'Your Order Has Been Shipped',
            message: `Good news! Your order has been shipped. You can track its journey below.`
        },
        delivered: {
            subject: 'Your Order Has Been Delivered',
            message: 'Your order has been marked as delivered. We hope you enjoy your purchase!'
        }
    };
    console.log('here is the input : ' + clientEmail,
    customerName,
    status,
    orderID,
    websiteURL,
    bEmail,
    BEPass,
    clientName)
    const { subject, message } = statusMessages[status.toLowerCase()] || {
        subject: 'Order Update',
        message: 'There’s an update regarding your order.'
    };

    const viewOrderLink = `${websiteURL}/login`; // Adjust path if needed
    const trackOrderLink = `${websiteURL}/login`;

    const transporter = nodemailer.createTransport({
        host: 'smtpout.secureserver.net',
        port: 465,
        secure: true,
        auth: {
            user: bEmail,
            pass: BEPass
        }
    });

    const emailContent = `
        <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
            <h2 style="text-align: center; color: #444;">Order Update: ${status.toUpperCase()}</h2>
            <p>Hi ${customerName},</p>
            <p>${message}</p>
            <div style="margin: 20px 0; padding: 10px; background-color: #eef6fc; border-left: 4px solid #2196F3;">
                <h4 style="margin-bottom: 10px;">Order ID</h4>
                <p>${orderID}</p>
            </div>
            <p><a href="${viewOrderLink}" style="background-color: #2196F3; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">View My Order</a></p>
            ${status === 'shipped' ? `
            <p style="margin-top: 20px;"><a href="${trackOrderLink}" style="background-color: #4CAF50; color: white; padding: 10px 15px; text-decoration: none; border-radius: 5px;">Track My Order</a></p>
            ` : ''}
            <p style="margin-top: 30px;">If you have any questions, feel free to reply to this email.</p>
            <p>Warm regards,<br>${formattedClientName}</p>

            <hr style="margin-top: 40px;">
            <p style="font-size: 12px; color: #888;">This email is a notification from ${formattedClientName.replace('The ', '').replace(' Team', '')}.</p>
        </div>
    `;

    try {
        // Send email to client
        await sendWithRetry(transporter, { from: bEmail, to: clientEmail, subject , html: emailContent });

        // Send email to business (yourself)
        await sendWithRetry(transporter, { from: bEmail, to: bEmail, subject , html: emailContent });

        console.log(`Order status email (${status}) sent to client successfully`);
    } catch (error) {
        console.error(`Error sending order status (${status}) email:`, error);
        throw error;
    }
}

async function sendResetPasswordEmail(
    clientEmail,
    customerName,
    websiteURL,
    resetLink,
    bEmail,
    BEPass,
    clientName,
) {
    const formattedClientName = clientName
        ? 'The ' + clientName
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, str => str.toUpperCase())
            .trim() + ' Team'
        : 'The Khana Technologies Team';

    const transporter = nodemailer.createTransport({
        host: 'smtpout.secureserver.net',
        port: 465,
        secure: true,
        auth: {
            user: bEmail,
            pass: BEPass
        }
    });

const emailContent = `
  <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: auto;">
    <h2 style="text-align: center; color: #444;">Reset Your Password</h2>
    <p>Hi ${customerName},</p>
    <p>We received a request to reset your password for your account at <strong>${websiteURL}</strong>.</p>
    <p>If you made this request, click the button below to reset your password:</p>

    <div style="text-align: center; margin: 30px 0;">
      <a href="${resetLink}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px;">
        Reset My Password
      </a>
    </div>

    <p>This link will expire shortly. If you did not request this, please ignore this email.</p>

    <p style="margin-top: 30px;">If you have any questions, feel free to reply to this email.</p>
    <p>Warm regards,<br>${formattedClientName}</p>

    <hr style="margin-top: 40px;">
    <p style="font-size: 12px; color: #888;">This email is a password reset notification from ${formattedClientName.replace('The ', '').replace(' Team', '')}.</p>
  </div>
`;


    try {
        // Send email to client
        await sendWithRetry(transporter, { from: bEmail, to: clientEmail, subject: 'Reset Password', html: emailContent });
        console.log(`Email sent to client successfully`);
    } catch (error) {
        console.error(`Error sending email:`, error);
        throw error;
    }
}
 

module.exports = { sendOrderConfirmationEmail,sendOrderStatusUpdateEmail,sendResetPasswordEmail };
