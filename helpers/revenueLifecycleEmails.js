const { sendMailWithRetry } = require('./mailer');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('./mailHost');
const { resolveEmailBrand } = require('./emailDesignTokens');
const { decrypt } = require('./encryption');
const {
  buildKhanaEmail,
  escapeHtml,
  ctaButton,
} = require('./transactionalEmailLayout');
const { inlineEmailBannerLogosAsync } = require('./inlineEmailBannerLogo');
const { formatEmailAttachments } = require('./formatEmailAttachments');

function smtpFromClient(client) {
  const decryptedEmail = decrypt(client.businessEmail);
  const decryptedPass = decrypt(client.businessEmailPassword);
  const smtpHost = resolveSmtpHost(client);
  const smtpPort = resolveSmtpPort(client, smtpHost);
  return {
    host: smtpHost,
    port: smtpPort,
    secure: resolveSmtpSecure(smtpPort),
    user: decryptedEmail,
    pass: decryptedPass,
    from: `"${client.companyName}" <${decryptedEmail}>`,
    decryptedEmail,
  };
}

async function sendLifecycleEmail(client, { to, subject, headline, bodyHtml, preheader, clientID }) {
  const smtp = smtpFromClient(client);
  const brand = resolveEmailBrand(client);
  const html = buildKhanaEmail({
    headline,
    title: subject,
    preheader,
    bodyHtml,
    brandName: client.companyName || brand.brandName,
    logoUrl: brand.logoUrl,
    showKhanaLogo: false,
    primaryColor: brand.primaryColor,
  });
  const { html: htmlOut, attachments } = await inlineEmailBannerLogosAsync(html, [], {});
  const text = preheader;

  await sendMailWithRetry(
    {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      user: smtp.user,
      pass: smtp.pass,
      from: smtp.from,
      to,
      subject,
      text,
      html: htmlOut,
      attachments: formatEmailAttachments(attachments || []),
      clientID,
      saveToSent: false,
    },
    3
  );
}

async function sendWinBackEmail(customer, client) {
  const first = escapeHtml(customer.customerFirstName || 'there');
  const storeUrl = client.return_url || '';
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${first},</p>
    <p style="margin:0 0 16px;">We haven't seen you in a while and we'd love to welcome you back.</p>
    <p style="margin:0 0 20px;">Browse what's new — we're here if you need anything.</p>
    ${storeUrl ? ctaButton({ href: storeUrl, label: 'Visit us again' }) : ''}
  `;
  await sendLifecycleEmail(client, {
    to: customer.emailAddress,
    subject: `We miss you at ${client.companyName}`,
    headline: 'Come back soon',
    preheader: `A quick hello from ${client.companyName}`,
    bodyHtml,
    clientID: client.clientID,
  });
}

async function sendPostPurchaseEmail(customer, client, orderSummary = '') {
  const first = escapeHtml(customer.customerFirstName || 'there');
  const storeUrl = client.return_url || '';
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${first},</p>
    <p style="margin:0 0 16px;">Thank you for your recent order${orderSummary ? ` — ${escapeHtml(orderSummary)}` : ''}.</p>
    <p style="margin:0 0 20px;">If you loved your purchase, explore more while you're here.</p>
    ${storeUrl ? ctaButton({ href: storeUrl, label: 'Shop again' }) : ''}
  `;
  await sendLifecycleEmail(client, {
    to: customer.emailAddress,
    subject: `Thank you for shopping at ${client.companyName}`,
    headline: 'Thanks for your order',
    preheader: `Your order at ${client.companyName}`,
    bodyHtml,
    clientID: client.clientID,
  });
}

async function sendBookingAbandonmentEmail(booking, client) {
  const first = escapeHtml((booking.customerName || '').split(/\s+/)[0] || 'there');
  const storeUrl = client.return_url || '';
  const services = (booking.services || []).map((s) => escapeHtml(s)).join(', ');
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${first},</p>
    <p style="margin:0 0 16px;">You started a booking${services ? ` for <strong>${services}</strong>` : ''} but didn't finish confirming.</p>
    <p style="margin:0 0 20px;">Your slot may still be available — complete your booking when you're ready.</p>
    ${storeUrl ? ctaButton({ href: storeUrl, label: 'Complete booking' }) : ''}
  `;
  await sendLifecycleEmail(client, {
    to: booking.customerEmail,
    subject: `Complete your booking at ${client.companyName}`,
    headline: 'Finish your booking',
    preheader: 'Your appointment is waiting',
    bodyHtml,
    clientID: client.clientID,
  });
}

module.exports = {
  sendWinBackEmail,
  sendPostPurchaseEmail,
  sendBookingAbandonmentEmail,
};
