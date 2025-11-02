const nodemailer = require('nodemailer');
const Product = require('../models/product');

async function sendWithRetry(transporter, mailOptions, retries = 1, delayMs = 1500) {
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

// -----------------------------
// Order Confirmation Email
// -----------------------------
async function sendOrderConfirmationEmail(clientEmail, orderItems, bEmail, BEPass, shipping, clientName, orderID) {
    const formattedClientName = clientName
        ? 'The ' + clientName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim() + ' Team'
        : 'The Khana Technologies Team';

    const transporter = nodemailer.createTransport({
        host: `mail.${bEmail.split('@')[1]}`, // auto-detect domain
        port: 465,
        secure: true,
        auth: { user: bEmail, pass: BEPass },
        tls: { rejectUnauthorized: false }
    });

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
    const formattedClientName = clientName
        ? 'The ' + clientName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim() + ' Team'
        : 'The Khana Technologies Team';

    const statusMessages = {
        processed: { subject: 'Your Order Has Been Processed', message: 'We’ve finished preparing your order and it’s now processed. It will be shipped soon.' },
        shipped: { subject: 'Your Order Has Been Shipped', message: 'Good news! Your order has been shipped. You can track it below.' },
        delivered: { subject: 'Your Order Has Been Delivered', message: 'Your order has been marked as delivered. We hope you enjoy your purchase!' }
    };

    const { subject, message } = statusMessages[status.toLowerCase()] || { subject: 'Order Update', message: 'There’s an update regarding your order.' };

    const transporter = nodemailer.createTransport({
        host: `mail.${bEmail.split('@')[1]}`,
        port: 465,
        secure: true,
        auth: { user: bEmail, pass: BEPass },
        tls: { rejectUnauthorized: false }
    });

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
// Reset Password Email
// -----------------------------
async function sendResetPasswordEmail(clientEmail, customerName, websiteURL, resetLink, bEmail, BEPass, clientName) {
    const formattedClientName = clientName
        ? 'The ' + clientName.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase()).trim() + ' Team'
        : 'The Khana Technologies Team';

    const transporter = nodemailer.createTransport({
        host: `mail.${bEmail.split('@')[1]}`,
        port: 465,
        secure: true,
        auth: { user: bEmail, pass: BEPass },
        tls: { rejectUnauthorized: false }
    });

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

module.exports = { sendOrderConfirmationEmail, sendOrderStatusUpdateEmail, sendResetPasswordEmail };
