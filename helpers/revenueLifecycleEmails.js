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

async function sendLifecycleEmail(client, { to, subject, headline, bodyHtml, preheader, text, clientID }) {
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
    footerHtml: `Automated message from ${escapeHtml(client.companyName || brand.brandName || 'us')}.`,
    primaryColor: brand.primaryColor,
  });
  const { html: htmlOut, attachments } = await inlineEmailBannerLogosAsync(html, [], {});
  const textOut =
    text ||
    (htmlOut || '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

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
      text: textOut,
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
  const brandName = client.companyName || 'us';
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${first},</p>
    <p style="margin:0 0 16px;">We haven't seen you in a while and we'd love to welcome you back.</p>
    <p style="margin:0 0 20px;">Browse what's new — we're here if you need anything.</p>
    ${storeUrl ? ctaButton({ href: storeUrl, label: 'Visit us again' }) : ''}
  `;
  const text = `Hi ${customer.customerFirstName || 'there'},

We haven't seen you in a while and we'd love to welcome you back.

Browse what's new at ${brandName}.
${storeUrl ? `\nVisit us: ${storeUrl}` : ''}

— ${brandName}`;
  await sendLifecycleEmail(client, {
    to: customer.emailAddress,
    subject: `We miss you at ${client.companyName}`,
    headline: 'Come back soon',
    preheader: `A quick hello from ${client.companyName}`,
    bodyHtml,
    text,
    clientID: client.clientID,
  });
}

async function sendPostPurchaseEmail(customer, client, orderSummary = '') {
  const first = escapeHtml(customer.customerFirstName || 'there');
  const storeUrl = client.return_url || '';
  const brandName = client.companyName || 'us';
  const summaryPlain = orderSummary ? ` — ${orderSummary}` : '';
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${first},</p>
    <p style="margin:0 0 16px;">Thank you for your recent order${orderSummary ? ` — ${escapeHtml(orderSummary)}` : ''}.</p>
    <p style="margin:0 0 20px;">If you loved your purchase, explore more while you're here.</p>
    ${storeUrl ? ctaButton({ href: storeUrl, label: 'Shop again' }) : ''}
  `;
  const text = `Hi ${customer.customerFirstName || 'there'},

Thank you for your recent order${summaryPlain}.

If you loved your purchase, explore more at ${brandName}.
${storeUrl ? `\nShop again: ${storeUrl}` : ''}

— ${brandName}`;
  await sendLifecycleEmail(client, {
    to: customer.emailAddress,
    subject: `Thank you for shopping at ${client.companyName}`,
    headline: 'Thanks for your order',
    preheader: `Your order at ${client.companyName}`,
    bodyHtml,
    text,
    clientID: client.clientID,
  });
}

async function sendBookingAbandonmentEmail(booking, client) {
  const first = escapeHtml((booking.customerName || '').split(/\s+/)[0] || 'there');
  const storeUrl = client.return_url || '';
  const brandName = client.companyName || 'us';
  const services = (booking.services || []).map((s) => escapeHtml(s)).join(', ');
  const servicesPlain = (booking.services || []).join(', ');
  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${first},</p>
    <p style="margin:0 0 16px;">You started a booking${services ? ` for <strong>${services}</strong>` : ''} but didn't finish confirming.</p>
    <p style="margin:0 0 20px;">Your slot may still be available — complete your booking when you're ready.</p>
    ${storeUrl ? ctaButton({ href: storeUrl, label: 'Complete booking' }) : ''}
  `;
  const text = `Hi ${(booking.customerName || '').split(/\s+/)[0] || 'there'},

You started a booking${servicesPlain ? ` for ${servicesPlain}` : ''} but didn't finish confirming.

Your slot may still be available — complete your booking when you're ready.
${storeUrl ? `\nComplete booking: ${storeUrl}` : ''}

— ${brandName}`;
  await sendLifecycleEmail(client, {
    to: booking.customerEmail,
    subject: `Complete your booking at ${client.companyName}`,
    headline: 'Finish your booking',
    preheader: 'Your appointment is waiting',
    bodyHtml,
    text,
    clientID: client.clientID,
  });
}

module.exports = {
  sendWinBackEmail,
  sendPostPurchaseEmail,
  sendBookingAbandonmentEmail,
};
