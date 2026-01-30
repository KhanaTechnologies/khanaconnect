// utils/cartReminderEmail.js
const { sendMail } = require('../helpers/mailer');

async function sendCartReminderEmail(customer, client) {
  try {
    const domain = client.return_url?.replace(/^https?:\/\//, '').split('/')[0];
    const smtpHost = client.imapHost || `mail.${domain}`;

    const cartItems = customer.cart.map(item => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">
          ${item.image ? `<img src="${item.image}" alt="${item.productName}" width="50" style="border-radius: 5px;">` : ''}
        </td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.productName}</td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">${item.quantity}</td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">R${item.price.toFixed(2)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">R${(item.price * item.quantity).toFixed(2)}</td>
      </tr>
    `).join('');

    const total = customer.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #333;">Complete Your Purchase at ${client.companyName}</h2>
        <p>Hi ${customer.customerFirstName},</p>
        <p>We noticed you have items waiting in your cart. Don't miss out on these great products!</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
          <thead>
            <tr style="background-color: #f8f9fa;">
              <th style="padding: 10px; text-align: left;">Image</th>
              <th style="padding: 10px; text-align: left;">Product</th>
              <th style="padding: 10px; text-align: left;">Qty</th>
              <th style="padding: 10px; text-align: left;">Price</th>
              <th style="padding: 10px; text-align: left;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${cartItems}
          </tbody>
        </table>
        
        <div style="text-align: right; font-size: 18px; font-weight: bold; margin: 20px 0;">
          Cart Total: R${total.toFixed(2)}
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${client.return_url}/cart" 
             style="background-color: #007bff; color: white; padding: 12px 30px; 
                    text-decoration: none; border-radius: 5px; display: inline-block;
                    font-size: 16px; font-weight: bold;">
            Complete Your Order Now
          </a>
        </div>
        
        <p style="color: #666; font-size: 12px; margin-top: 30px;">
          This is an automated reminder from ${client.companyName}. 
          You can manage your cart reminder preferences in your account settings.
        </p>
      </div>
    `;

    const text = `Hi ${customer.customerFirstName},

You have items waiting in your cart at ${client.companyName}:

${customer.cart.map(item => 
  `- ${item.productName} (${item.quantity} x R${item.price.toFixed(2)}) = R${(item.price * item.quantity).toFixed(2)}`
).join('\n')}

Cart Total: R${total.toFixed(2)}

Complete your order here: ${client.return_url}/cart

This is an automated reminder. You can manage your cart reminder preferences in your account settings.`;

    await sendMail({
      host: smtpHost,
      port: 465,
      secure: true,
      user: client.businessEmail,
      pass: client.businessEmailPassword,
      from: `"${client.companyName}" <${client.businessEmail}>`,
      to: customer.emailAddress,
      subject: `🛒 Complete Your Order - ${client.companyName}`,
      text,
      html
    });

    console.log(`📧 Cart reminder sent to ${customer.emailAddress}`);
  } catch (error) {
    console.error('Error sending cart reminder email:', error);
    throw error;
  }
}

module.exports = { sendCartReminderEmail };