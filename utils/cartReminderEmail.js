// utils/cartReminderEmail.js
const { sendMail } = require('../helpers/mailer');
const { resolveEmailBrand } = require('../helpers/emailDesignTokens');
const { decrypt } = require('../helpers/encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('../helpers/mailHost');
const {
  buildKhanaEmail,
  escapeHtml,
  ctaButton,
} = require('../helpers/transactionalEmailLayout');
const { inlineEmailBannerLogosAsync } = require('../helpers/inlineEmailBannerLogo');
const { formatEmailAttachments } = require('../helpers/formatEmailAttachments');

async function sendCartReminderEmail(customer, client) {
  try {
    const decryptedEmail = decrypt(client.businessEmail);
    const decryptedPass = decrypt(client.businessEmailPassword);

    const smtpHost = resolveSmtpHost({
      smtpHost: client.smtpHost,
      imapHost: client.imapHost,
      businessEmail: decryptedEmail,
      return_url: client.return_url,
    });
    const smtpPort = resolveSmtpPort(client, smtpHost);

    const cartItems = customer.cart.map(item => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">
          ${item.image ? `<img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.productName)}" width="50" style="border-radius: 5px;">` : ''}
        </td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">${escapeHtml(item.productName)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">${escapeHtml(item.quantity)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">R${Number(item.price).toFixed(2)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #eee;">R${(item.price * item.quantity).toFixed(2)}</td>
      </tr>
    `).join('');

    const total = customer.cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    const cartUrl = `${client.return_url}/cart`;
    const brand = resolveEmailBrand(client);
    const brandName = String(client.companyName || 'Our store');
    const logoUrl = brand.logoUrl || undefined;

    const bodyHtml = `
      <p style="margin:0 0 16px;">Hi ${escapeHtml(customer.customerFirstName)},</p>
      <p style="margin:0 0 16px;">We noticed you have items waiting in your cart. Don't miss out on these great products!</p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 20px;font-size:14px;">
        <thead>
          <tr style="background-color:#f8f9fa;">
            <th style="padding:10px;text-align:left;">Image</th>
            <th style="padding:10px;text-align:left;">Product</th>
            <th style="padding:10px;text-align:left;">Qty</th>
            <th style="padding:10px;text-align:left;">Price</th>
            <th style="padding:10px;text-align:left;">Total</th>
          </tr>
        </thead>
        <tbody>${cartItems}</tbody>
      </table>
      <p style="margin:0 0 20px;text-align:right;font-size:18px;font-weight:700;">Cart total: R${total.toFixed(2)}</p>
      ${ctaButton({ href: cartUrl, label: 'Complete your order now' })}
    `;

    const html = buildKhanaEmail({
      headline: 'Complete your purchase',
      title: `Your cart at ${brandName}`,
      preheader: `You have ${customer.cart.length} item(s) waiting in your cart.`,
      bodyHtml,
      brandName,
      logoUrl,
      showKhanaLogo: false,
      footerHtml: `Automated reminder from ${escapeHtml(brandName)}. Manage cart reminders in your account settings.`,
      primaryColor: brand.primaryColor,
    });

    const text = `Hi ${customer.customerFirstName},

You have items waiting in your cart at ${client.companyName}:

${customer.cart.map(item =>
  `- ${item.productName} (${item.quantity} x R${item.price.toFixed(2)}) = R${(item.price * item.quantity).toFixed(2)}`
).join('\n')}

Cart total: R${total.toFixed(2)}

Complete your order: ${cartUrl}`;

    const { html: htmlOut, attachments } = await inlineEmailBannerLogosAsync(html, [], {});

    await sendMail({
      host: smtpHost,
      port: smtpPort,
      secure: resolveSmtpSecure(smtpPort),
      user: decryptedEmail,
      pass: decryptedPass,
      from: `"${client.companyName}" <${decryptedEmail}>`,
      to: customer.emailAddress,
      subject: `Complete your purchase at ${client.companyName}`,
      text,
      html: htmlOut,
      attachments: formatEmailAttachments(attachments || []),
      clientID: client.clientID,
      saveToSent: false,
    });

    console.log(`Cart reminder email sent to ${customer.emailAddress}`);
  } catch (error) {
    console.error('Error sending cart reminder email:', error);
    throw error;
  }
}

module.exports = { sendCartReminderEmail };
