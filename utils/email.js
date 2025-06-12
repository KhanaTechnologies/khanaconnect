const nodemailer = require('nodemailer');
const { OrderItem } = require('../models/orderItem');
const Product = require('../models/product');

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
        await transporter.sendMail({
            from: bEmail, // Your GoDaddy email address
            to: clientEmail, // Client's email address
            subject: 'Order Confirmation',
            html: emailContent
        });

        console.log('Order confirmation email sent to client successfully');

        // Send email to business (yourself)
        await transporter.sendMail({
            from: bEmail, // Your GoDaddy email address
            to: bEmail, // Business email (your email address)
            subject: 'New Order Received',
            html: emailContent // Reuse the same content
        });

        console.log('Order confirmation email sent to business successfully');

    } catch (error) {
        console.error('Error sending order confirmation email:', error);
        throw error; // Throw error to handle it in the calling function
    }
}
 

module.exports = { sendOrderConfirmationEmail };
