const { sendMailWithRetry } = require('./mailer');
const { decrypt } = require('./encryption');
const { resolveSmtpHost, resolveSmtpPort, resolveSmtpSecure } = require('./mailHost');
const { resolveEmailBrand } = require('./emailDesignTokens');
const { escapeHtml, ctaButton, buildKhanaEmail } = require('./transactionalEmailLayout');
const { inlineEmailBannerLogosAsync } = require('./inlineEmailBannerLogo');
const { formatEmailAttachments } = require('./formatEmailAttachments');

async function sendPreorderGoLiveEmail({ signup, campaign, client, subject, message, orderUrl }) {
  const decryptedEmail = decrypt(client.businessEmail);
  const decryptedPass = decrypt(client.businessEmailPassword);
  const smtpHost = resolveSmtpHost(client);
  const smtpPort = resolveSmtpPort(client, smtpHost);
  if (!smtpHost) {
    throw new Error('SMTP host could not be resolved for client');
  }

  const firstName = signup.customerInfo?.firstName || signup.customerInfo?.name || 'there';
  const brandName = String(client.companyName || 'Our store');
  const campaignName = campaign.name || 'Our campaign';
  const shopUrl = (orderUrl || client.return_url || '').replace(/\/$/, '') || '#';
  const messageHtml = escapeHtml(message || '').replace(/\n/g, '<br>');

  const bodyHtml = `
    <p style="margin:0 0 16px;">Hi ${escapeHtml(firstName)},</p>
    <p style="margin:0 0 16px;"><strong>${escapeHtml(campaignName)} is live!</strong></p>
    <p style="margin:0 0 20px;">${messageHtml}</p>
    ${ctaButton({ href: shopUrl, label: 'Order now' })}
    <p style="margin:16px 0 0;font-size:13px;color:#6b7280;">You signed up for updates about this campaign.</p>
  `;

  const brand = resolveEmailBrand(client);
  const emailSubject = subject || `${campaignName} — we're live! Order now`;
  const html = buildKhanaEmail({
    headline: 'We are live!',
    title: emailSubject,
    preheader: `${campaignName} is officially live — order now.`,
    bodyHtml,
    brandName,
    logoUrl: brand.logoUrl || undefined,
    showKhanaLogo: false,
    footerHtml: `Campaign update from ${escapeHtml(brandName)}.`,
    primaryColor: brand.primaryColor,
  });

  const text = `Hi ${firstName},

${campaignName} is live!

${message || ''}

Order now: ${shopUrl}

— ${brandName}`;

  const { html: htmlOut, attachments } = await inlineEmailBannerLogosAsync(html, [], {});

  await sendMailWithRetry(
    {
      host: smtpHost,
      port: smtpPort,
      secure: resolveSmtpSecure(smtpPort),
      user: decryptedEmail,
      pass: decryptedPass,
      from: `"${client.companyName}" <${decryptedEmail}>`,
      to: signup.customerInfo.email,
      subject: emailSubject,
      text,
      html: htmlOut,
      attachments: formatEmailAttachments(attachments || []),
      clientID: client.clientID,
      saveToSent: false,
    },
    3
  );
}

module.exports = { sendPreorderGoLiveEmail };
